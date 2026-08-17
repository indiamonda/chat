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
  - Support the student's wellbeing. Many students face heavy academic
    pressure and stress. You may comfort, reassure, calm down, and
    de-escalate a student who is stressed, anxious, overwhelmed, sad, or
    under pressure: offer a kind, non-judgmental ear and gentle, practical
    suggestions (take a break, breathe, talk to someone, prioritise). This
    is encouraged.
  - Continuously monitor the student's emotional / psychological state
    across the conversation. If the state reaches an EMERGENCY -- extremely
    urgent, extreme, and serious (immediate risk of suicide, self-harm,
    abuse, violence, or a severe crisis) -- OR the student explicitly asks
    for emergency help, STOP and respond with immediate care: urge them to
    contact help NOW and give the emergency numbers (911 for an immediate
    emergency; 988 Suicide & Crisis Lifeline -- call or text 988; Crisis
    Text Line -- text HOME to 741741; school counselor / a trusted adult).
    Never refuse or lecture in an emergency.
  - Do NOT diagnose, treat, prescribe for, or act as a therapist for any
    mental-health condition (that is for a licensed human). Comfort and
    calming are fine; clinical treatment is not.
  - No medical, legal, or other safety-critical advice (only a licensed
    human can give that).
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

Be warm, kind and encouraging in every reply. You are talking to a real
high-school student who is often stressed; sound like a friendly, caring human
-- never cold, robotic, or like a corporate helpdesk. Use a little emoji where
it helps you feel friendly and approachable, but never in a crisis or a
policy refusal.
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
    Returns a short paragraph describing today's PAUSD calendar phase +
    upcoming Paly / Gunn events for the next 90 days.

    The phase text itself is computed client-side and passed in via the
    request payload (extras.get('calendar_phase') / 'calendar_season'
    / 'calendar_school_context'). For per-school events, we ship the
    same hardcoded data as the frontend so Layer 3 sees them.
    """
    return ''  # populated by route from request extras


# Per-school events for Palo Alto High School (Paly) and Henry M. Gunn
# High School. Mirror of the frontend's PAUSD_CALENDAR.schools map.
# Dates are typical for each event (homecoming early Oct; prom Mar/Apr;
# graduation on the last day of school). They're hardcoded here from the
# schools' historically-published calendars and should be refreshed when
# the schools publish new dates for an upcoming year.
SCHOOL_EVENTS = {
    '2025-2026': {
        'paly': [
            {'date': '2025-10-03', 'name': 'Homecoming Football Game', 'type': 'sports'},
            {'date': '2025-10-04', 'name': 'Homecoming Dance',         'type': 'dance'},
            {'date': '2025-12-12', 'name': 'Winter Formal',            'type': 'dance'},
            {'date': '2026-03-12', 'name': 'Spring Musical (opens)',   'type': 'performance'},
            {'date': '2026-03-14', 'name': 'Spring Musical',           'type': 'performance'},
            {'date': '2026-03-15', 'name': 'Spring Musical',           'type': 'performance'},
            {'date': '2026-04-25', 'name': 'Prom',                      'type': 'dance'},
            {'date': '2026-06-04', 'name': 'Graduation',               'type': 'ceremony'},
        ],
        'gunn': [
            {'date': '2025-10-10', 'name': 'Homecoming Football Game', 'type': 'sports'},
            {'date': '2025-10-11', 'name': 'Homecoming Dance',         'type': 'dance'},
            {'date': '2026-02-13', 'name': 'Winter Formal',            'type': 'dance'},
            {'date': '2026-03-19', 'name': 'Spring Musical (opens)',   'type': 'performance'},
            {'date': '2026-03-21', 'name': 'Spring Musical',           'type': 'performance'},
            {'date': '2026-03-22', 'name': 'Spring Musical',           'type': 'performance'},
            {'date': '2026-03-28', 'name': 'Prom',                      'type': 'dance'},
            {'date': '2026-06-03', 'name': 'Graduation',               'type': 'ceremony'},
        ],
    },
    '2026-2027': {
        'paly': [
            {'date': '2026-10-02', 'name': 'Homecoming Football Game', 'type': 'sports'},
            {'date': '2026-10-03', 'name': 'Homecoming Dance',         'type': 'dance'},
            {'date': '2026-12-11', 'name': 'Winter Formal',            'type': 'dance'},
            {'date': '2027-03-11', 'name': 'Spring Musical (opens)',   'type': 'performance'},
            {'date': '2027-03-13', 'name': 'Spring Musical',           'type': 'performance'},
            {'date': '2027-03-14', 'name': 'Spring Musical',           'type': 'performance'},
            {'date': '2027-04-24', 'name': 'Prom',                      'type': 'dance'},
            {'date': '2027-06-03', 'name': 'Graduation',               'type': 'ceremony'},
        ],
        'gunn': [
            {'date': '2026-10-09', 'name': 'Homecoming Football Game', 'type': 'sports'},
            {'date': '2026-10-10', 'name': 'Homecoming Dance',         'type': 'dance'},
            {'date': '2027-02-12', 'name': 'Winter Formal',            'type': 'dance'},
            {'date': '2027-03-18', 'name': 'Spring Musical (opens)',   'type': 'performance'},
            {'date': '2027-03-20', 'name': 'Spring Musical',           'type': 'performance'},
            {'date': '2027-03-21', 'name': 'Spring Musical',           'type': 'performance'},
            {'date': '2027-03-27', 'name': 'Prom',                      'type': 'dance'},
            {'date': '2027-06-02', 'name': 'Graduation',               'type': 'ceremony'},
        ],
    },
}


def build_school_events_block(from_iso: str, to_iso: str) -> str:
    """Return a short block listing per-school events in the date range.
    Used by Layer 3's planner context so the AI can reference upcoming
    Paly / Gunn dances, performances, prom, graduation, etc.
    """
    out = []
    for year_key, schools in SCHOOL_EVENTS.items():
        for school, events in schools.items():
            for ev in events:
                if from_iso <= ev['date'] <= to_iso:
                    school_label = 'Palo Alto HS' if school == 'paly' else 'Henry M. Gunn HS'
                    out.append(f"  - {ev['date']} {school_label}: {ev['name']} ({ev['type']})")
    if not out:
        return ''
    return ('UPCOMING SCHOOL EVENTS (Paly / Gunn, '
            + f"{from_iso} through {to_iso} -- typical dates; "
            "check school sites for confirmation):\n"
            + '\n'.join(out))


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