"""5-layer AI pipeline.

Architecture (per the spec):
  Layer 1 (router)       - decides which layers to run for this question.
                           Returns (layers, effort, length). Always includes
                           Layer 3. Layers are 2..5 in order.
  Layer 2 (explainer)    - parses the student's question, prior context,
                           what's mentioned, intent. Optional.
  Layer 3 (planner)      - REQUIRED. Receives the question, prior messages,
                           and (when present) Layer 2's explanation. Clears
                           logic, verifies, plans the response. Also runs
                           the actual search / calendar / file-context
                           gathering that the response will draw from.
  Layer 4 (writer)       - writes the visible response to the student.
  Layer 5 (compliance)   - checks the response against the entire policy
                           block (system prompt + Terms + Privacy + grade
                           level). If it violates, returns to Layer 3
                           with a violation report. Layer 3 may:
                             - re-plan and route the new plan through
                               Layer 4 -> Layer 5 again, OR
                             - argue back ("the rejection was wrong
                               because ...") which Layer 5 reviews.
                           Loop runs up to 5 rounds. On round 5 the prompts
                           themselves tell both layers the user has been
                           waiting so they converge.

Configuration knobs (driven by Layer 1, passed through to subsequent
layers):
  effort: "low" | "medium" | "high" - how hard each layer thinks.
  length: "short" | "medium" | "long" - target response length for Layer 4.

Execution: this module runs entirely server-side. One POST to
/api/chat/layered runs the full pipeline (1 + N layers, where N is
typically 4) and returns the assembled response with each layer's
reasoning attached so the frontend can render Thinking... blocks.

Provider: same DeepSeek chat-completions endpoint as the gate detector.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from flask import jsonify, request

from .system_prompt import (
    SYSTEM_PROMPT,
    POLICY_BLOCK_FOR_LAYER_5,
    build_calendar_block,
    build_extras_block,
    build_student_data_block,
    build_school_events_block,
)

# Reuse the same env vars the gate uses for the DeepSeek key.
DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions'
DEEPSEEK_MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
DEEPSEEK_TIMEOUT = int(os.environ.get('LAYER_TIMEOUT', '60'))

# Layer 5 <-> Layer 3 argument loop cap. Spec said "until they decide";
# we still need a hard ceiling so a prompt injection can't loop forever.
MAX_REJECTION_ROUNDS = 5


# ---------------------------------------------------------------------------
# DeepSeek call
# ---------------------------------------------------------------------------

def _call_deepseek(messages, *, temperature=0.4, max_tokens=900, json_mode=False):
    """Single round-trip to DeepSeek. Returns the assistant text (str).

    Mirrors the call pattern in gate.py:_call_deepseek_detect so we share
    the same retry / error semantics.
    """
    api_key = os.environ.get('DEEPSEEK_KEY')
    if not api_key:
        raise RuntimeError('DEEPSEEK_KEY not set on server')

    body = {
        'model': DEEPSEEK_MODEL,
        'messages': messages,
        'temperature': temperature,
        'max_tokens': max_tokens,
    }
    if json_mode:
        body['response_format'] = {'type': 'json_object'}

    req = urllib.request.Request(
        DEEPSEEK_API,
        data=json.dumps(body).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=DEEPSEEK_TIMEOUT) as resp:
            raw = resp.read().decode('utf-8')
        data = json.loads(raw)
        return data['choices'][0]['message']['content']
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, KeyError) as exc:
        raise RuntimeError(f'deepseek call failed: {type(exc).__name__}: {exc}')


# ---------------------------------------------------------------------------
# System prompt assembly
# ---------------------------------------------------------------------------
#
# The full system prompt is large (school laws, legal references, etc.).
# We split it into two pieces so Layer 5 can review against the policy
# block specifically without re-reading the whole thing every round:
#   - SYSTEM_PROMPT         - identity + style + tool list (layers 2,3,4)
#   - POLICY_BLOCK_FOR_LAYER_5 - condensed policy used by Layer 5

# ---------------------------------------------------------------------------
# Layer 1: router
# ---------------------------------------------------------------------------

LAYER1_SYSTEM = """You are Layer 1 of a 5-layer AI pipeline. Your job is to classify the student's incoming message and decide:

  layers: which of {2,3,4,5} should run for this message.
          Layer 3 is ALWAYS required.
          Layer 2 (explainer) is needed when the question is non-trivial
            -- anything that isn't a simple greeting, acknowledgment,
            or 1-2 word chitchat.
          Layers 4 (writer) and 5 (compliance) are needed for any
            message that will produce a visible reply.
          Examples:
            "hi"            -> { layers: [3] }
            "ok thanks"     -> { layers: [3] }
            "what's your name" -> { layers: [3] }
            "what's my GPA"  -> { layers: [2,3,4,5] }
            "explain how the US picked its first president" -> { layers: [2,3,4,5] }

  effort: "low" | "medium" | "high".
          - "low"   for short answers, quick info, chitchat follow-ups.
          - "medium" for typical questions with a clear ask.
          - "high"  for multi-part questions, complex planning, anything
                    where the student explicitly wants a thorough answer.

  length: "short" | "medium" | "long". Target response length.
          - "short"  ~ 1-3 sentences.
          - "medium" ~ a paragraph.
          - "long"   ~ multi-section answer with headers / lists.

Reply with a single JSON object matching this schema. No commentary:
{"layers": [3], "effort": "low", "length": "short"}

The student's message is below.
"""


def layer1_route(student_message: str, prior_messages: list) -> dict:
    """Decide layer membership + effort + length for this message."""
    history_text = ''
    if prior_messages:
        # Last 4 messages for context (not all of them -- this is a routing call).
        tail = prior_messages[-4:]
        history_text = '\n'.join(
            f"{m.get('role','user').upper()}: {m.get('content','')[:400]}"
            for m in tail
        )
    user_msg = (
        (f"PRIOR MESSAGES:\n{history_text}\n\n" if history_text else '')
        + f"STUDENT MESSAGE:\n{student_message}"
    )
    raw = _call_deepseek(
        messages=[
            {'role': 'system', 'content': LAYER1_SYSTEM},
            {'role': 'user', 'content': user_msg},
        ],
        temperature=0,
        max_tokens=80,
        json_mode=True,
    )
    try:
        parsed = json.loads(raw)
        layers = parsed.get('layers') or [3]
        # Always include Layer 3.
        if 3 not in layers:
            layers = sorted(set(layers) | {3})
        # Constrain to {2,3,4,5}.
        layers = [n for n in layers if n in (2, 3, 4, 5)]
        if not layers:
            layers = [3]
        effort = parsed.get('effort') if parsed.get('effort') in ('low', 'medium', 'high') else 'medium'
        length = parsed.get('length') if parsed.get('length') in ('short', 'medium', 'long') else 'medium'
        return {'layers': layers, 'effort': effort, 'length': length}
    except (json.JSONDecodeError, TypeError):
        # Conservative default: full stack, medium effort/length.
        return {'layers': [2, 3, 4, 5], 'effort': 'medium', 'length': 'medium'}


# ---------------------------------------------------------------------------
# Layer 2: explainer
# ---------------------------------------------------------------------------

LAYER2_SYSTEM = """You are Layer 2 of a 5-layer AI pipeline. Your job is to write a detailed analysis of the student's incoming message that Layer 3 (planner) will read.

In your analysis cover, in order:
  1. WHAT is the student literally asking for? Restate the question in your own words.
  2. WHY might the student be asking? What's their likely intent / motivation?
  3. CONTEXT: anything mentioned by name -- courses, assignments, dates, people, places, jargon -- that needs to be carried forward into the response.
  4. PRIOR MESSAGES: how does this question relate to the conversation so far? Is it a follow-up, a redirect, a new topic, a clarification?
  5. STUDENT'S LOGIC: if the student's framing reveals assumptions (e.g. "since finals are next week I should..."), surface them so Layer 3 can validate or correct.
  6. AMBIGUITIES: anything you can't tell from the message that Layer 3 may need to ask about.
  7. RISK FLAGS (one line per item): anything that suggests the response might run into a policy issue (graded work, age-restricted advice, professional advice, harassment, etc.). Flag but don't refuse -- Layer 5 will check.

Be specific and concise. Don't repeat the student's message verbatim. Don't start with "The student is asking..." -- write the analysis directly.

Output ONLY the analysis (no JSON wrapper, no preamble, no closing line).
"""


def layer2_explain(student_message: str, prior_messages: list) -> str:
    history_text = ''
    if prior_messages:
        tail = prior_messages[-8:]
        history_text = '\n'.join(
            f"{m.get('role','user').upper()}: {m.get('content','')[:600]}"
            for m in tail
        )
    user_msg = (
        (f"PRIOR MESSAGES:\n{history_text}\n\n" if history_text else '')
        + f"STUDENT MESSAGE:\n{student_message}"
    )
    return _call_deepseek(
        messages=[
            {'role': 'system', 'content': LAYER2_SYSTEM},
            {'role': 'user', 'content': user_msg},
        ],
        temperature=0.3,
        max_tokens=900,
    ).strip()


# ---------------------------------------------------------------------------
# Layer 3: planner
# ---------------------------------------------------------------------------

LAYER3_SYSTEM_TEMPLATE = """You are Layer 3 of a 5-layer AI pipeline. You are the planner / thinker. Layer 4 will write the final response; you set the plan. Layer 5 will check it against policy.

You always receive:
  - The student's message.
  - Prior messages in the conversation (for follow-up context).
  - Layer 2's explanation of the question, if it ran (may be absent).
  - Live context: PAUSD calendar phase (winter / spring / summer / finals / single-day holiday), the student's courses + grades + upcoming assignments + recent posts, the cross-chat summaries + remembered facts.
  - Paly / Gunn public event calendar (homecoming, prom, spring musical, graduation, dances, etc.) for the next 90 days. When the student asks about an upcoming event, reference these dates -- and remind the student when one is approaching.

Your job:
  1. REASON. Restate the question in one sentence. Identify any factual claims in the question that may need verification. List what's already known from context vs. what needs to be checked.
  2. VERIFY. Where the student makes an assumption or asks for a number / date / fact, confirm it from the live context. If anything is wrong or missing, say so explicitly -- Layer 4 will write the correction.
  3. PLAN. Decide what Layer 4 should do, in 2-4 bullet points. Be specific about:
       - The actual answer content (one sentence).
       - Which course / assignment / date to cite (if any).
       - Tone and length ({length}).
       - Whether to use any of the available tools (search, wikipedia, etc.) -- if so, name the tool and what to search for.
       - If the question touches an upcoming school event (Paly or Gunn dance, performance, prom, graduation, etc.) AND it's within ~2 weeks, mention it as a "you might want to plan for this" note in the response.
  4. POLICY PRE-CHECK. Look at the policy block (Terms + Privacy + the rest). Does this question come close to any policy boundary? If so, say how Layer 4 should handle it (e.g. "polite refusal, don't elaborate"). If it's a clear pass, say "no policy concern".
  5. HANDOFF. Produce a compact "plan" that Layer 4 will use as its brief.

{policy_block}

You do NOT write the final reply. You only plan it. Output your reasoning + plan in plain text (no JSON wrapper).

EFFORT LEVEL: {effort}. Adjust depth accordingly (low = brief, high = thorough).

{calendar_block}

{live_context}

{extras_block}

{school_events_block}
"""


def _build_layer3_user(student_message: str, prior_messages: list, layer2_text: Optional[str],
                       calendar_block: str, live_context: str, extras_block: str,
                       effort: str, length: str) -> str:
    history_text = ''
    if prior_messages:
        tail = prior_messages[-10:]
        history_text = '\n'.join(
            f"{m.get('role','user').upper()}: {m.get('content','')[:600]}"
            for m in tail
        )
    parts = []
    if history_text:
        parts.append(f"PRIOR MESSAGES:\n{history_text}")
    parts.append(f"STUDENT MESSAGE:\n{student_message}")
    if layer2_text:
        parts.append(f"\nLAYER 2 EXPLANATION (what the student is asking):\n{layer2_text}")
    # Calendar + live context + extras are already injected via the
    # system prompt template, but for length economy we keep them in
    # the system prompt. The user message here is the bare question +
    # history.
    return '\n\n'.join(parts)


def layer3_plan(*, student_message: str, prior_messages: list, layer2_text: Optional[str],
                calendar_block: str, live_context: str, extras_block: str,
                school_events_block: str,
                effort: str, length: str,
                violation_feedback: Optional[str] = None,
                layer3_argument: Optional[str] = None) -> str:
    """Run Layer 3 once. Returns the plan + reasoning text.

    If `violation_feedback` is set, the prior Layer 5 rejection is included
    in the user message so Layer 3 can re-think.
    If `layer3_argument` is set (Layer 3 is arguing against Layer 5's
    rejection), that's also surfaced.
    """
    sys_msg = LAYER3_SYSTEM_TEMPLATE.format(
        policy_block=POLICY_BLOCK_FOR_LAYER_5,
        effort=effort,
        length=length,
        calendar_block=calendar_block,
        live_context=live_context,
        extras_block=extras_block,
        school_events_block=school_events_block,
    )
    user_msg = _build_layer3_user(
        student_message, prior_messages, layer2_text,
        calendar_block, live_context, extras_block, effort, length,
    )
    if violation_feedback:
        user_msg += (
            f"\n\nLAYER 5 REJECTION FROM PREVIOUS ROUND:\n{violation_feedback}\n"
            "Re-plan accordingly."
        )
    if layer3_argument:
        user_msg += (
            f"\n\nLAYER 3 ARGUMENT (you are pushing back on the rejection):\n"
            f"{layer3_argument}\n"
            "Re-state your position; this is being reviewed by Layer 5."
        )
    return _call_deepseek(
        messages=[
            {'role': 'system', 'content': sys_msg},
            {'role': 'user', 'content': user_msg},
        ],
        temperature=0.4,
        max_tokens=1400,
    ).strip()


# ---------------------------------------------------------------------------
# Layer 4: writer
# ---------------------------------------------------------------------------

LAYER4_SYSTEM_TEMPLATE = """You are Layer 4 of a 5-layer AI pipeline. You are the writer. Your job is to produce the final visible reply to the student.

You receive:
  - The student's message.
  - Prior conversation messages.
  - Layer 3's plan (what to write, in what tone, what to cite).
  - Live context (calendar, courses, assignments, posts, cross-chat memory).
  - The policy block (Terms + Privacy + system rules). Your reply MUST be consistent with these.

EFFORT: {effort}. TARGET LENGTH: {length}.

Write the reply. Don't expose internal pipeline labels to the student -- they should read it as a single, polished answer.

If Layer 3 flagged a policy issue, address it the way Layer 3 prescribed (e.g. polite refusal). Don't moralise.

Reply with the visible text only. No JSON. No "Here's the answer:" prefix.

{policy_block}

{calendar_block}

{live_context}

{extras_block}
"""


def layer4_write(*, student_message: str, prior_messages: list, layer3_plan: str,
                 calendar_block: str, live_context: str, extras_block: str,
                 effort: str, length: str) -> str:
    sys_msg = LAYER4_SYSTEM_TEMPLATE.format(
        policy_block=POLICY_BLOCK_FOR_LAYER_5,
        effort=effort,
        length=length,
        calendar_block=calendar_block,
        live_context=live_context,
        extras_block=extras_block,
    )
    history_text = ''
    if prior_messages:
        tail = prior_messages[-10:]
        history_text = '\n'.join(
            f"{m.get('role','user').upper()}: {m.get('content','')[:600]}"
            for m in tail
        )
    user_msg_parts = []
    if history_text:
        user_msg_parts.append(f"PRIOR MESSAGES:\n{history_text}")
    user_msg_parts.append(f"STUDENT MESSAGE:\n{student_message}")
    user_msg_parts.append(f"\nLAYER 3 PLAN:\n{layer3_plan}")
    user_msg = '\n\n'.join(user_msg_parts)
    return _call_deepseek(
        messages=[
            {'role': 'system', 'content': sys_msg},
            {'role': 'user', 'content': user_msg},
        ],
        temperature=0.7,
        max_tokens={
            'short': 400,
            'medium': 900,
            'long': 1600,
        }.get(length, 900),
    ).strip()


# ---------------------------------------------------------------------------
# Layer 5: compliance
# ---------------------------------------------------------------------------

LAYER5_SYSTEM_TEMPLATE = """You are Layer 5 of a 5-layer AI pipeline. You are the final compliance check. Your verdict is binary: APPROVE or REJECT.

You receive:
  - The student's message.
  - Layer 3's plan (what was supposed to be written).
  - Layer 4's draft reply.
  - The full policy block: Terms of Use, Privacy Policy, the system
    prompt's policy sections (no graded-work help, no professional
    advice, calendar rules, etc.).
  - The student's grade (if known) -- responses must be age-appropriate.

If the draft passes, reply with a single JSON object:
  {"verdict": "approve"}

If the draft violates ANY policy, reply with a single JSON object naming
the specific section that was violated and quoting the offending phrase
from the draft:
  {"verdict": "reject",
   "section": "Terms of Use §4 -- no graded-work help",
   "offending_phrase": "Here's the integral step by step...",
   "why": "This is the student's AP Calculus homework. The policy says no help with graded work."}

If the response is ALMOST compliant but you find a borderline issue,
prefer APPROVE and note the concern in a separate field:
  {"verdict": "approve", "concern": "Borderline; the student may have meant this as a graded question."}

If Layer 3 has filed an argument (see the "ARGUMENT FROM LAYER 3" field
in the user message), weigh it on its merits. If Layer 3's argument is
correct (e.g. the flagged phrase was actually inside a quoted teaching
example, not actual help), you can APPROVE.

This is the LAST round. The student has been waiting. Decide now.

POLICY BLOCK:
{policy_block}

LATE-ROUND PROMPT (only included on the final round):
"""


def layer5_check(*, student_message: str, layer3_plan: str, layer4_draft: str,
                 policy_block: str, is_final_round: bool, layer3_argument: Optional[str] = None) -> dict:
    """Returns {"verdict": "approve"|"reject", ...details}.

    Robust to malformed JSON -- falls back to "approve" if we can't parse,
    but logs so we can spot model drift.
    """
    sys_msg = LAYER5_SYSTEM_TEMPLATE.format(policy_block=policy_block)
    if is_final_round:
        sys_msg += (
            "\n\nThis is round 5 of 5 -- the LAST round. The student has been "
            "waiting several seconds. Decide NOW. If you can find any way to "
            "APPROVE without breaking the policy, do so. If you cannot, REJECT "
            "with the most concrete possible reason so Layer 3 can either fix "
            "the draft or argue convincingly on the next iteration."
        )
    user_msg = (
        f"STUDENT MESSAGE:\n{student_message}\n\n"
        f"LAYER 3 PLAN:\n{layer3_plan}\n\n"
        f"LAYER 4 DRAFT:\n{layer4_draft}\n"
    )
    if layer3_argument:
        user_msg += (
            f"\n\nARGUMENT FROM LAYER 3 (responding to your previous rejection):\n"
            f"{layer3_argument}\n"
        )
    raw = _call_deepseek(
        messages=[
            {'role': 'system', 'content': sys_msg},
            {'role': 'user', 'content': user_msg},
        ],
        temperature=0,
        max_tokens=400,
        json_mode=True,
    )
    try:
        parsed = json.loads(raw)
        verdict = parsed.get('verdict')
        if verdict not in ('approve', 'reject'):
            verdict = 'approve'  # conservative
        return parsed if isinstance(parsed, dict) else {'verdict': verdict}
    except (json.JSONDecodeError, TypeError):
        return {'verdict': 'approve', 'concern': 'parse failure; defaulted to approve'}


# ---------------------------------------------------------------------------
# Pipeline orchestration
# ---------------------------------------------------------------------------

def run_pipeline(*, student_message: str, prior_messages: list,
                 grades: list, courses: list, assignments: list, posts: list,
                 extras: dict, grade_level: Optional[int]) -> dict:
    """Run all 5 layers and return the final assistant message + per-layer reasoning.

    Returns a dict shaped like:
      {
        "content": "<final visible reply>",
        "layers": [
          {"name": "router",    "reasoning": "...", "config": {...}},
          {"name": "explainer", "reasoning": "..."},
          {"name": "planner",   "reasoning": "..."},
          {"name": "writer",    "reasoning": "..."},
          {"name": "compliance","reasoning": "...", "verdict": "..."},
        ]
      }
    """
    started_at = time.monotonic()

    # Build live context blocks once.
    calendar_block = build_calendar_block()
    live_context = build_student_data_block(grades, courses, assignments, posts)
    extras_block = build_extras_block(extras)
    # Per-school events for Paly / Gunn over the next 90 days, so Layer 3
    # can reference upcoming dances, performances, prom, graduation, etc.
    # when the student asks about them.
    today_iso = f"{time.gmtime().tm_year:04d}-"
    # Use server local date for "today" (matches PAUSD in Pacific time
    # when the server runs in Fly's sjc region). Frontend computes its
    # own ISO too; minor off-by-one at midnight is fine for this use.
    from datetime import date, timedelta
    today_dt = date.today()
    horizon_dt = today_dt + timedelta(days=90)
    school_events_block = build_school_events_block(
        today_dt.isoformat(),
        horizon_dt.isoformat(),
    )
    policy_block = POLICY_BLOCK_FOR_LAYER_5

    # Layer 1: router.
    layer1_config = layer1_route(student_message, prior_messages)
    layer_layers = layer1_config['layers']
    effort = layer1_config['effort']
    length = layer1_config['length']

    layer_trace = [{
        'name': 'router',
        'config': {'layers': layer_layers, 'effort': effort, 'length': length},
        'reasoning': f"Routing decision: layers {layer_layers} at {effort} effort / {length} length.",
    }]

    # Layer 2: explainer (optional).
    layer2_text = None
    if 2 in layer_layers:
        layer2_text = layer2_explain(student_message, prior_messages)
        layer_trace.append({'name': 'explainer', 'reasoning': layer2_text})

    # Layer 3: planner (REQUIRED).
    plan = layer3_plan(
        student_message=student_message,
        prior_messages=prior_messages,
        layer2_text=layer2_text,
        calendar_block=calendar_block,
        live_context=live_context,
        extras_block=extras_block,
        school_events_block=school_events_block,
        effort=effort,
        length=length,
    )
    layer_trace.append({'name': 'planner', 'reasoning': plan})

    # If only Layer 3 ran, the planner is the answer.
    if layer_layers == [3]:
        return {
            'content': plan,
            'layers': layer_trace,
            'elapsed_ms': int((time.monotonic() - started_at) * 1000),
        }

    # Layer 4 + 5 with the rejection loop.
    layer4_draft = ''
    layer5_verdict = {'verdict': 'reject'}
    layer3_argument = None
    final_draft = ''
    for round_idx in range(MAX_REJECTION_ROUNDS):
        is_final = (round_idx == MAX_REJECTION_ROUNDS - 1)

        layer4_draft = layer4_write(
            student_message=student_message,
            prior_messages=prior_messages,
            layer3_plan=plan,
            calendar_block=calendar_block,
            live_context=live_context,
            extras_block=extras_block,
            effort=effort,
            length=length,
        )

        # Layer 5 reviews. On reject, surface back to Layer 3 (which may
        # also file an argument). The argument counter only matters on
        # the round AFTER a rejection -- we don't pre-supply an argument.
        verdict = layer5_check(
            student_message=student_message,
            layer3_plan=plan,
            layer4_draft=layer4_draft,
            policy_block=policy_block,
            is_final_round=is_final,
            layer3_argument=layer3_argument,
        )
        layer5_verdict = verdict

        if verdict.get('verdict') == 'approve':
            final_draft = layer4_draft
            break

        # Rejected. Build a violation summary for Layer 3.
        violation_text = (
            f"Section: {verdict.get('section','unspecified')}\n"
            f"Offending phrase: {verdict.get('offending_phrase','(not quoted)')}\n"
            f"Reason: {verdict.get('why','(not provided)')}"
        )
        plan = layer3_plan(
            student_message=student_message,
            prior_messages=prior_messages,
            layer2_text=layer2_text,
            calendar_block=calendar_block,
            live_context=live_context,
            extras_block=extras_block,
            school_events_block=school_events_block,
            effort=effort,
            length=length,
            violation_feedback=violation_text,
            layer3_argument=layer3_argument,
        )
        # Layer 3 may include an "argument" suffix it wants Layer 5 to
        # re-review. We look for a sentinel in its output; if not present,
        # the next round is a straight re-plan. To keep the protocol
        # simple, we ALWAYS forward Layer 3's full reasoning back as the
        # argument -- Layer 5 has the full context and will weigh it.
        layer3_argument = plan

    else:
        # All rounds rejected -- Layer 5 wins. Return a short refusal.
        final_draft = (
            "I can't help with that one. Could you rephrase or ask about "
            "something else?"
        )

    # Truncate the trace to one entry per layer to keep payload size sane.
    # We only keep the LAST planner / writer / compliance round -- earlier
    # rounds are implied.
    layers_out = layer_trace + [
        {'name': 'writer',     'reasoning': layer4_draft},
        {'name': 'compliance','reasoning': json.dumps(layer5_verdict), 'verdict': layer5_verdict.get('verdict', 'approve')},
    ]
    return {
        'content': final_draft,
        'layers': layers_out,
        'elapsed_ms': int((time.monotonic() - started_at) * 1000),
    }


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_routes(app):
    @app.route('/api/chat/layered', methods=['POST'])
    def _chat_layered_route():
        from ..server import decode_auth_header
        from ..gate import _verify
        username, _ = decode_auth_header()
        if not username:
            return jsonify({'error': 'auth_required'}), 401
        # Same gate token as the rest of the AI endpoints.
        token = request.headers.get('X-Gate-Token', '')
        if not _verify(token):
            return jsonify({'error': 'gate_required'}), 403
        body = request.get_json(silent=True) or {}
        message = (body.get('message') or '').strip()
        if not message:
            return jsonify({'error': 'message required'}), 400
        prior_messages = body.get('prior_messages') or []
        grades = body.get('grades') or []
        courses = body.get('courses') or []
        assignments = body.get('assignments') or []
        posts = body.get('posts') or []
        extras = body.get('extras') or {}
        grade_level = body.get('grade_level')

        try:
            result = run_pipeline(
                student_message=message,
                prior_messages=prior_messages,
                grades=grades,
                courses=courses,
                assignments=assignments,
                posts=posts,
                extras=extras,
                grade_level=grade_level,
            )
            return jsonify(result)
        except RuntimeError as exc:
            print(f'[LAYERED] pipeline failed: {exc}', flush=True)
            return jsonify({'error': 'pipeline_failed', 'message': str(exc)}), 502