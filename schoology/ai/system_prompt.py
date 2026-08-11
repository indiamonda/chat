"""Shared system-prompt pieces for the 5-layer AI pipeline.

The full system prompt currently lives in schoology/index.html (built
client-side via buildContextMessages). The server-side layered pipeline
needs the same content but server-side. Rather than duplicate, this
module exposes the policy block + helpers as plain strings so the
backend can reference them without touching the frontend.

The actual *primary* system prompt used by layers 3 and 4 is built
per-call via SYSTEM_PROMPT + the per-layer header. POLICY_BLOCK_FOR_LAYER_5
is the condensed text Layer 5 reviews against.
"""

# Condensed policy that Layer 5 reviews against. Layers 2,3,4 get the
# full SYSTEM_PROMPT in their system messages; Layer 5 only needs the
# rules, not the writing-style guidance.
POLICY_BLOCK_FOR_LAYER_5 = """\
The AI Assistant's policy is:
  - PAUSD students only; grade >= 9 (verified at sign-in).
  - No help with GRADED work: do not solve, outline, draft, paraphrase,
    translate, summarise, or rewrite any work the student could submit
    for a grade. Exception: a teacher has explicitly allowed AI for the
    specific assignment (you'll see that in the live data).
  - Allowed topics: schedules, future planning, organisation, school
    rights / policy questions (Cal. Educ. Code, FERPA, Title IX, 504,
    IDEA, etc.), Schoology navigation, non-academic topics.
  - Refusal style: brief, polite, redirect-and-stop. Don't lecture.
  - No medical, legal, mental-health, or other safety-critical advice
    (only a licensed human can give that).
  - No targeting, harassment, doxing.
  - Respect the student's actual grade level -- a 9th-grader's advice
    should not include senior-only options.
  - Calendar-aware: don't suggest "make up missing assignments" if the
    gradebook has closed; don't say "talk to your teacher today" during
    summer break, etc.
  - Data use: don't ask for or repeat passwords / personal data beyond
    what's already in the live context.
"""

# Identity / style block for layers 2, 3, 4. Layers 2 and 3 also see the
# policy block; Layer 4 sees the policy block plus style guidance.
SYSTEM_PROMPT = """\
You are the AI Assistant for a PAUSD (Palo Alto Unified School District)
student dashboard. You help with schedules, future planning, organisation,
school rights, and any topic unrelated to the student's graded work.

You are layered: the user sees Thinking... blocks for each pipeline layer.
Don't expose the layer names in your reply -- write a single polished answer.
"""


# ---------------------------------------------------------------------------
# Live-context helpers
# ---------------------------------------------------------------------------
#
# The frontend already builds these blocks; the backend re-builds them
# from the request payload so we don't need to share code with the
# frontend. Keep these short -- tokens cost money.

def build_calendar_block() -> str:
    """Server-side mirror of the frontend's buildCalendarPromptSection.
    Returns a short paragraph describing today's PAUSD calendar phase."""
    # We could re-import the PAUSD_CALENDAR from index.html, but that's
    # client-only. Instead, the frontend sends the phase already computed.
    # The route accepts phase via extras.get('phase') and uses that here.
    return ''  # populated by route from request extras


def build_student_data_block(grades, courses, assignments, posts) -> str:
    parts = []
    if grades:
        parts.append('COURSES / GRADES:')
        for g in grades[:20]:
            pct = g.get('percentage')
            letter = g.get('letterGrade') or 'N/A'
            name = g.get('courseName') or g.get('title') or 'Unknown course'
            pct_str = f"{pct}%" if pct is not None else 'N/A'
            parts.append(f"  - {name}: {pct_str} ({letter})")
    if courses:
        parts.append('\nCOURSES (enrolled):')
        for c in courses[:20]:
            name = c.get('title') or c.get('courseName') or 'Unknown'
            parts.append(f"  - {name}")
    if assignments:
        parts.append('\nUPCOMING ASSIGNMENTS:')
        for a in assignments[:20]:
            name = a.get('title') or 'Untitled'
            course = a.get('courseName') or a.get('course') or 'Unknown course'
            due = a.get('dueDate') or a.get('due_iso') or a.get('due') or 'No due date'
            parts.append(f"  - {name} ({course}) -- due {due}")
    if posts:
        parts.append('\nRECENT POSTS:')
        for p in posts[:10]:
            author = p.get('author') or 'Someone'
            content = (p.get('content') or p.get('text') or '')[:120]
            parts.append(f"  - {author}: {content}")
    return '\n'.join(parts) if parts else 'No live school data available.'


def build_extras_block(extras: dict) -> str:
    parts = []
    mem = extras.get('globalMemory') or []
    if mem:
        parts.append('REMEMBERED FACTS:')
        for m in mem[:10]:
            parts.append(f"  - {m.get('text', '')}")
    summaries = extras.get('otherSummaries') or []
    if summaries:
        parts.append('\nOTHER CHATS (for awareness only; do NOT proactively reference):')
        for s in summaries[:8]:
            parts.append(f"  - {s.get('title','(untitled)')}: {s.get('summary','')[:160]}")
    return '\n'.join(parts) if parts else ''