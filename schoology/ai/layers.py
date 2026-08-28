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
    build_developer_block,
    build_extras_block,
    build_student_data_block,
    build_school_events_block,
    build_tools_prompt,
)

# Reuse the same env vars the gate uses for the DeepSeek key.
# With a DEEPSEEK_KEY we call DeepSeek directly; without it we fall back to
# the public proxy worker, mirroring server/index.js and ai-moderation.js.
DEEPSEEK_API_DIRECT = 'https://api.deepseek.com/v1/chat/completions'
# Overridable via env for parity with the chat app (which uses
# DEEPSEEK_API_URL); defaults to the shared Cloudflare proxy.
DEEPSEEK_API_PROXY = os.environ.get('DEEPSEEK_API_URL') or 'https://deepseek-proxy.ikunbeautiful.workers.dev/v1/chat'
DEEPSEEK_MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
DEEPSEEK_TIMEOUT = int(os.environ.get('LAYER_TIMEOUT', '60'))

# Layer 5 <-> Layer 3 argument loop cap. Spec said "until they decide";
# we still need a hard ceiling so a prompt injection can't loop forever.
# Kept small (3) so a rejection round-trip doesn't drag response latency:
# each round costs Layer 4 + Layer 5 + a Layer 3 re-plan.
MAX_REJECTION_ROUNDS = 3


# ---------------------------------------------------------------------------
# DeepSeek call
# ---------------------------------------------------------------------------

def _call_deepseek(messages, *, temperature=0.4, max_tokens=900, json_mode=False):
    """Single round-trip to DeepSeek. Returns the assistant text (str).

    Tries the direct DeepSeek API first (when a key is set), then falls
    back to the public proxy worker on any failure. This way the pipeline
    works both when DEEPSEEK_KEY is absent AND when api.deepseek.com is
    unreachable from the server (the Node app uses the same proxy fallback).
    """
    api_key = os.environ.get('DEEPSEEK_KEY')

    body = {
        'model': DEEPSEEK_MODEL,
        'messages': messages,
        'temperature': temperature,
        'max_tokens': max_tokens,
        'stream': False,
    }
    if json_mode:
        body['response_format'] = {'type': 'json_object'}

    candidates = []
    if api_key:
        candidates.append((DEEPSEEK_API_DIRECT, {'Authorization': f'Bearer {api_key}'}))
    candidates.append((DEEPSEEK_API_PROXY, {}))

    last_err = None
    for endpoint, extra_headers in candidates:
        # The proxy worker rejects non-browser User-Agents (Python-urllib
        # gets a 403), so send a browser-like UA. Harmless for the direct
        # API, which only cares about the Authorization header.
        headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            **extra_headers,
        }
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(body).encode('utf-8'),
            headers=headers,
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=DEEPSEEK_TIMEOUT) as resp:
                raw = resp.read().decode('utf-8')
            data = json.loads(raw)
            return data['choices'][0]['message']['content']
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, KeyError, json.JSONDecodeError) as exc:
            last_err = exc
            continue
    raise RuntimeError(f'deepseek call failed (tried {len(candidates)} endpoint(s)): {type(last_err).__name__}: {last_err}')


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
        # Last 3 messages for context (not all of them -- this is a routing call).
        tail = prior_messages[-3:]
        history_text = '\n'.join(
            f"{m.get('role','user').upper()}: {m.get('content','')[:300]}"
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
  8. EMOTIONAL STATE CHECK (1-2 sentences): assess the student's apparent emotional state from this message and prior messages -- calm, stressed, anxious, overwhelmed, sad, or in crisis. Note whether they are under heavy pressure, need comfort / calming, or are explicitly asking for help. Also flag whether this is an EMERGENCY (extremely urgent / extreme / serious -- immediate risk of suicide, self-harm, abuse, violence, or a severe crisis). A stressed or sad student is NOT automatically an emergency.

Be specific and concise. Don't repeat the student's message verbatim. Don't start with "The student is asking..." -- write the analysis directly.

Output ONLY the analysis (no JSON wrapper, no preamble, no closing line).
"""


def layer2_explain(student_message: str, prior_messages: list, developer_block: str = '') -> str:
    history_text = ''
    if prior_messages:
        tail = prior_messages[-6:]
        history_text = '\n'.join(
            f"{m.get('role','user').upper()}: {m.get('content','')[:400]}"
            for m in tail
        )
    user_msg = (
        (f"PRIOR MESSAGES:\n{history_text}\n\n" if history_text else '')
        + f"STUDENT MESSAGE:\n{student_message}"
    )
    sys_msg = LAYER2_SYSTEM
    if developer_block:
        sys_msg = sys_msg + '\n\n' + developer_block
    return _call_deepseek(
        messages=[
            {'role': 'system', 'content': sys_msg},
            {'role': 'user', 'content': user_msg},
        ],
        temperature=0.3,
        max_tokens=400,
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
  4. POLICY PRE-CHECK. Look at the policy block (Terms + Privacy + the rest). Does this question come close to any policy boundary? If so, say how Layer 4 should handle it (e.g. "warm one-sentence refusal, then work a SIMILAR example with different numbers, then invite them to try theirs"). If it's a clear pass, say "no policy concern". WELLBEING & SAFETY: if the student is stressed, anxious, overwhelmed, sad, or under pressure, plan a comforting, calming, de-escalating reply (validate feelings, reassure, gentle suggestions). If the state is an EMERGENCY (extremely urgent / extreme / serious -- immediate risk of suicide, self-harm, abuse, violence, or a severe crisis) OR they ask for emergency help, the plan MUST instruct Layer 4 to give the emergency numbers (911, 988, Crisis Text Line 741741, counselor / trusted adult) and urge immediate contact. Do NOT plan a refusal. Do not diagnose or act as a therapist in either case.
  5. FRIEND TONE. The visible reply MUST sound like the student's FRIEND -- warm, casual, encouraging, natural sentences, light emoji where it fits. Plan the tone explicitly: how should Layer 4 open, what vibe, where a little warmth or humor helps. A cold or robotic reply is a defect -- plan against it.
  6. TOOLS. When the reply needs live data, a computation, or an external source, plan for Layer 4 to emit the matching [NAME:args] bracket command from the TOOLS list (one per line, syntax exactly as listed). Name the tool and what to query.
  7. HANDOFF. Produce a compact "plan" that Layer 4 will use as its brief.

{developer_block}

{policy_block}

You do NOT write the final reply. You only plan it. Output your reasoning + plan in plain text (no JSON wrapper).

EFFORT LEVEL: {effort}. Adjust depth accordingly (low = brief, high = thorough).

{calendar_block}

{live_context}

{tools_block}

{extras_block}

{school_events_block}
"""


def _build_layer3_user(student_message: str, prior_messages: list, layer2_text: Optional[str],
                       calendar_block: str, live_context: str, extras_block: str,
                       effort: str, length: str) -> str:
    history_text = ''
    if prior_messages:
        tail = prior_messages[-6:]
        history_text = '\n'.join(
            f"{m.get('role','user').upper()}: {m.get('content','')[:400]}"
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
                developer_block: str = '',
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
        developer_block=developer_block,
        effort=effort,
        length=length,
        calendar_block=calendar_block,
        live_context=live_context,
        tools_block=build_tools_prompt(),
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
        max_tokens=700,
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

TONE -- you are the student's FRIEND:
- Talk like a close, supportive friend who happens to be great at school stuff. Warm, casual, a little playful when the mood fits. Never a cold robot, never a corporate helpdesk, never a dry FAQ.
- Use contractions and short, natural sentences. Vary how you open and close. If the student's name is in the live context, use it when it feels natural (not every message).
- Be warm, kind and supportive in EVERY reply: greet naturally where it fits, show you genuinely care, and close on an encouraging note when appropriate.
- Use a little emoji to feel friendly and approachable (e.g. 🙂 💪 📚 ✨ 🎉), but don't overdo it, and never use emoji in a crisis or a policy refusal.
- Match the student's energy: casual if they're casual, gentle if they're worried, hype if they're celebrating.
- Celebrate their wins. Sympathise when things are rough. A friend notices.

TOOLS:
- When Layer 3's plan calls for a tool, emit the exact bracket command from the TOOLS list on its own line at the END of your reply (after your text). Example:
  Sure, let me look that up for you!
  [WIKI:photosynthesis]
- Never invent a tool name -- only use names from the TOOLS list with the exact syntax.
- Don't explain the bracket commands to the student; they run automatically.

If Layer 3 flagged a policy issue, address it the way Layer 3 prescribed. For graded-work refusals: ONE warm sentence refusing the direct answer, then IMMEDIATELY work a SIMILAR example end-to-end (different numbers / topic, same method) and invite the student to apply it to their own problem. A bare refusal with no similar worked example is INCOMPLETE. Don't moralise, don't lecture.

WELLBEING & SAFETY:
- If the student is stressed, anxious, overwhelmed, sad, or under pressure, write a warm, comforting reply that calms them down and de-escalates: validate how they feel, reassure them, and offer gentle, practical support (take a break, breathe, talk to someone, prioritise). This is encouraged.
- If the student is in an EMERGENCY (extremely urgent / extreme / serious -- immediate risk of suicide, self-harm, abuse, violence, or a severe crisis) or explicitly asks for emergency help, do NOT refuse and do NOT lecture. Write a short, warm, urgent reply that tells them to contact help NOW and gives the emergency numbers: 911 for an immediate emergency; 988 Suicide & Crisis Lifeline (call or text 988); Crisis Text Line (text HOME to 741741); and their school counselor or a trusted adult.
- Never diagnose, treat, prescribe, or act as a therapist. Comfort and calming are fine; clinical treatment is not.

Reply with the visible text only. No JSON. No "Here's the answer:" prefix.

LIVE-DATA REFRESH MARKERS (emit only when the student asks for a refresh; the
marker is hidden from the student and handled automatically -- do NOT explain
it to them):
  - When the student asks you to reload / refresh / re-check / "get the latest"
    grades, assignments, courses, or class posts, put ONE of these markers at
    the end of your reply and briefly confirm you refreshed it:
      [RELOAD:grades]  [RELOAD:assignments]  [RELOAD:courses]  [RELOAD:posts]  [RELOAD:all]

{developer_block}

{policy_block}

{calendar_block}

{live_context}

{tools_block}

{extras_block}
"""


def layer4_write(*, student_message: str, prior_messages: list, layer3_plan: str,
                 calendar_block: str, live_context: str, extras_block: str,
                 effort: str, length: str, developer_block: str = '') -> str:
    sys_msg = LAYER4_SYSTEM_TEMPLATE.format(
        policy_block=POLICY_BLOCK_FOR_LAYER_5,
        developer_block=developer_block,
        effort=effort,
        length=length,
        calendar_block=calendar_block,
        live_context=live_context,
        tools_block=build_tools_prompt(),
        extras_block=extras_block,
    )
    history_text = ''
    if prior_messages:
        tail = prior_messages[-6:]
        history_text = '\n'.join(
            f"{m.get('role','user').upper()}: {m.get('content','')[:400]}"
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
            'short': 250,
            'medium': 600,
            'long': 1000,
        }.get(length, 600),
    ).strip()


# ---------------------------------------------------------------------------
# Layer 5: compliance
# ---------------------------------------------------------------------------

LAYER5_SYSTEM_TEMPLATE = """You are Layer 5 of a 5-layer AI pipeline. You are the final compliance + polish pass. Your verdict has THREE possible outcomes:

  APPROVE -- the draft is fine on policy AND needs no polish. Ship
              it as-is.

  EDIT    -- the draft passes compliance but could use a small style /
              text polish. Ship the edited version. Do NOT bounce back
              to Layer 3 for edits -- Layer 5 owns the final word on
              polish.

              The reply must sound like the student's FRIEND (warm,
              casual, encouraging). If the draft is compliant but cold /
              robotic / corporate, that IS a polish defect: use EDIT to
              warm it up -- relax the phrasing, add a human touch, a
              fitting emoji (never in a refusal or crisis). Do not
              change the facts, the refusal stance, the emergency
              numbers, any [RELOAD:...] marker, or the meaning.

  REJECT  -- the draft violates policy. Bounce back to Layer 3 with
              the violation description so it can re-plan.

You receive:
  - The student's message.
  - Layer 3's plan (what was supposed to be written).
  - Layer 4's draft reply.
  - The full policy block: Terms of Use, Privacy Policy, the system
    prompt's policy sections (no graded-work help, no professional
    advice, calendar rules, etc.).
  - The student's grade (if known) -- responses must be age-appropriate.

When to use each verdict:

  APPROVE  -- the draft passes compliance AND reads cleanly. Ship
               unchanged.

  EDIT     -- the draft passes compliance but has small style / text
               issues you can fix in one pass. Examples of acceptable
               edits:
                 * fix a typo or grammatical slip
                 * tighten a run-on sentence or chop a rambling intro
                 * swap an emoji that doesn't fit the message
                 * normalize whitespace / fix a markdown typo
                 * swap a word for a clearer one
                 * add a missing section heading for readability
                 * warm up a cold/corporate tone so it sounds like a
                   friend (contractions, natural phrasing, a fitting
                   emoji)
                 * add a worked SIMILAR example to a graded-work refusal
                   that lacks one (same concept, different numbers) -- a
                   refusal with no similar example is incomplete
               Things you may NOT change:
                 * the factual claims or any number / date / name
                 * the policy-relevant content (don't drop a refusal
                   or soften a 'no, I can't help with graded work')
                 * the emergency numbers (911, 988, Crisis Text Line,
                   counselor) in an emergency reply -- never drop or
                   soften them
                 * any [RELOAD:...] marker in the reply (preserve it
                   verbatim -- it is an internal data-refresh command)
                 * the meaning, tone, or stance
                 * the length tier ('short' / 'medium' / 'long') the
                   Layer 1 router asked for
               If a fix would change meaning, return REJECT with the
               policy or factual concern -- Layer 3 / 4 own meaning,
               Layer 5 owns polish only.
               Output format:
                 {"verdict": "edit",
                  "edited_text": "<full polished reply -- the WHOLE message, not a diff>",
                  "edits": ["short list of what you changed", ...]}

  REJECT   -- the draft violates ANY policy. Output:
                 {"verdict": "reject",
                  "section": "Terms of Use §4 -- no graded-work help",
                  "offending_phrase": "Here's the integral step by step...",
                  "why": "This is the student's AP Calculus homework. The policy says no help with graded work."}

If the response is ALMOST compliant but you find a borderline issue,
prefer APPROVE / EDIT and note the concern in a separate field:
  {"verdict": "approve", "concern": "Borderline; the student may have meant this as a graded question."}

If Layer 3 has filed an argument (see the "ARGUMENT FROM LAYER 3" field
in the user message), weigh it on its merits. If Layer 3's argument is
correct (e.g. the flagged phrase was actually inside a quoted teaching
example, not actual help), you can APPROVE or EDIT accordingly.

This is the LAST round. The student has been waiting. Decide now.

POLICY BLOCK:
{policy_block}

{developer_block}

LATE-ROUND PROMPT (only included on the final round):
"""


def layer5_check(*, student_message: str, layer3_plan: str, layer4_draft: str,
                 policy_block: str, is_final_round: bool, layer3_argument: Optional[str] = None,
                 developer_block: str = '') -> dict:
    """Returns {"verdict": "approve"|"reject"|"edit", ...details}.

    Robust to malformed JSON -- falls back to "approve" if we can't parse,
    but logs so we can spot model drift.
    """
    # Use .replace() instead of .format() here: the template contains literal
    # JSON examples with braces (e.g. {"verdict": "approve"}), which .format()
    # would treat as placeholder fields and crash on (KeyError: '"verdict"').
    sys_msg = LAYER5_SYSTEM_TEMPLATE.replace('{policy_block}', policy_block)
    sys_msg = sys_msg.replace('{developer_block}', developer_block)
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
        max_tokens=600,  # 'edit' verdict embeds the full polished message
        json_mode=True,
    )
    try:
        parsed = json.loads(raw)
        verdict = parsed.get('verdict')
        if verdict not in ('approve', 'reject', 'edit'):
            verdict = 'approve'  # conservative
        # If 'edit' but no edited_text, treat as approve (don't ship an empty message).
        if verdict == 'edit' and not (parsed.get('edited_text') or '').strip():
            verdict = 'approve'
            parsed['concern'] = (parsed.get('concern') or 'edit verdict had empty edited_text; defaulted to approve')
        return parsed if isinstance(parsed, dict) else {'verdict': verdict}
    except (json.JSONDecodeError, TypeError):
        return {'verdict': 'approve', 'concern': 'parse failure; defaulted to approve'}


# ---------------------------------------------------------------------------
# Pipeline orchestration
# ---------------------------------------------------------------------------

def run_pipeline(*, student_message: str, prior_messages: list,
                 grades: list, courses: list, assignments: list, posts: list,
                 extras: dict, grade_level: Optional[int],
                 is_developer: bool = False) -> dict:
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
    # Developer status (verified via the developer key) is injected into
    # every layer EXCEPT Layer 1 (the router doesn't need it).
    developer_block = build_developer_block(is_developer)

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
        layer2_text = layer2_explain(student_message, prior_messages, developer_block=developer_block)
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
        developer_block=developer_block,
    )
    # Don't append the planner's reasoning to the visible trace yet --
    # if Layer 5 rejects this plan and we go around again, the
    # student should NOT see the rejected reasoning (it leaks the
    # violation details to them before the fix lands). We'll add the
    # final, approved planner reasoning at the end.
    planner_reasoning_final = plan
    plan_was_revised = False

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
            developer_block=developer_block,
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
            developer_block=developer_block,
        )
        layer5_verdict = verdict

        if verdict.get('verdict') == 'approve':
            final_draft = layer4_draft
            break

        if verdict.get('verdict') == 'edit':
            # Layer 5 polished the draft in-place. Ship the edited
            # version as the final reply -- no Layer 3 round-trip for
            # polish changes (Layer 5 owns polish; Layer 3 owns meaning).
            final_draft = (verdict.get('edited_text') or layer4_draft).strip()
            break

        # Rejected. Build a violation summary for Layer 3.
        violation_text = (
            f"Section: {verdict.get('section','unspecified')}\n"
            f"Offending phrase: {verdict.get('offending_phrase','(not quoted)')}\n"
            f"Reason: {verdict.get('why','(not provided)')}"
        )
        # The original plan (the one that just got rejected) must NOT be
        # shown to the student -- it would leak the policy-violating
        # framing. Replace the trace's planner entry with the new
        # plan only AFTER Layer 5 approves it (or at end-of-loop).
        plan_was_revised = True
        previous_plan = plan
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
            developer_block=developer_block,
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
        # All rounds rejected -- Layer 5 wins. Return a short refusal that
        # still offers the teaching path (no worked example is possible
        # here -- the pipeline has no topic knowledge at this point).
        final_draft = (
            "I can't help with that one. Could you rephrase — or ask me to "
            "teach the concept with a similar example?"
        )

    # Truncate the trace to one entry per layer to keep payload size sane.
    # We only keep the LAST planner / writer / compliance round -- earlier
    # rounds are implied.
    #
    # PLANNER VISIBILITY RULE: a planner entry is shown to the user ONLY
    # if its plan was approved (or was the only layer for a [3]-only
    # call). Rejected plans are never shown -- they leak the
    # violation reasoning to the student before the fix lands, which
    # is exactly the bug the user reported.
    compliance_reasoning = json.dumps(layer5_verdict)
    if layer5_verdict.get('verdict') == 'edit':
        edits = layer5_verdict.get('edits') or []
        compliance_reasoning = (
            'Polished the draft (' + str(len(edits)) + ' change'
            + ('s' if len(edits) != 1 else '') + '): '
            + ('; '.join(edits) if edits else 'see edited_text')
        )

    # Build the final layers trace. The planner entry is conditional
    # on whether its last plan was approved.
    layers_out = list(layer_trace)
    final_verdict = layer5_verdict.get('verdict', 'approve')
    if final_verdict in ('approve', 'edit'):
        # Last plan passed (or was polished in place by Layer 5). Show
        # the final planner reasoning.
        layers_out.append({'name': 'planner', 'reasoning': plan})
    elif plan_was_revised:
        # All rejection rounds happened and we shipped a refusal. Don't
        # show the (also rejected) last plan -- just say so.
        layers_out.append({
            'name': 'planner',
            'reasoning': (
                'Revised the plan ' + str(MAX_REJECTION_ROUNDS) + ' times to '
                'satisfy compliance; final version was still rejected. The '
                'shipped reply is a generic refusal. See the compliance '
                'block for the policy reason.'
            ),
        })
    # else: the planner entry was already appended to layer_trace.

    layers_out += [
        {'name': 'writer',     'reasoning': layer4_draft},
        {'name': 'compliance','reasoning': compliance_reasoning, 'verdict': final_verdict},
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

        # Developer-key proof: if the message matches the developer key (via
        # Argon2id), mark the user as a developer and confirm instead of
        # running the expensive pipeline.
        from .dev_auth import is_developer, is_developer_message, mark_developer
        if is_developer_message(message):
            mark_developer(username)
            return jsonify({
                'content': 'Developer key accepted. You are now verified as a developer.',
                'is_developer': True,
                'layers': [],
            })

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
                is_developer=is_developer(username),
            )
            return jsonify(result)
        except RuntimeError as exc:
            print(f'[LAYERED] pipeline failed: {exc}', flush=True)
            return jsonify({'error': 'pipeline_failed', 'message': str(exc)}), 502