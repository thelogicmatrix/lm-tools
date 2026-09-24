// The sweep vocabulary, in its own module so `jevescalate.mjs` can reuse the EXACT wording without
// importing jevjd.mjs, which runs a sweep on import. A verifier asked a paraphrase of the question
// is not verifying anything.

// THE VOCABULARY IS THE DESIGN DECISION, so it is deliberately wide. Jev cannot discover a category
// nobody named — it can only fail to fire — so a field left out here is invisible, and the only
// place that ever shows up is the untagged pile. Adding a question costs about 90 bytes of input
// and no latency (12 questions measured the same as 1), while a re-sweep costs $0.20 and five
// minutes. Being stingy is the expensive choice.
//
// Grouped by what each is FOR, because the groups are used differently downstream: group 1 is
// diffed against Orion's regexes, groups 2-4 are new capability, group 5 is Nathan's ask.
export const TAGS = {
  // 1. Applyability bars Orion already decides mechanically. These exist to be diffed.
  demands_3plus_years: 'This job description requires at least three years of prior work experience',
  requires_citizenship: 'This role is open only to citizens, excluding permanent residents',
  requires_chinese_fluency: 'This role requires fluent or professional-level Mandarin or Chinese',
  demands_elite_pedigree: 'This role requires a background in management consulting, investment banking, private equity, or a top-tier technology company',
  not_full_time: 'This posting is for an internship, part-time, casual or seasonal position rather than full-time employment',

  // 2. Bars nothing upstream can currently see at all. Each one has cost a real application or was
  // caught by hand: language beyond Chinese, clearances, and licences never had a rule.
  requires_other_language: 'This role requires fluency in a language other than English or Chinese, such as Japanese, Korean, Bahasa, Thai or Vietnamese',
  requires_security_clearance: 'This role requires a government security clearance or a statutory background check',
  requires_specific_degree: 'This role requires a degree in a named field, rather than any degree or no degree at all',
  requires_licence_or_vehicle: 'This role requires a driving licence, the applicant\'s own vehicle, or a professional licence or certification held before starting',
  shift_or_weekend_work: 'This role involves shift work, night work, or regular weekend or public holiday hours',
  frequent_travel: 'This role requires frequent travel or extended time away from Singapore',

  // 3. Fit and ranking. The axes brief.md targets on, which today are judged by hand at stage 4.
  ai_is_differentiator: 'AI or automation capability would distinguish a candidate here, rather than being a baseline requirement the applicant must already meet',
  is_developer_seat: 'This role requires writing and maintaining production software as a primary duty',
  uses_named_automation_tool: 'This posting names a specific low-code or automation platform, such as Power Platform, Power Automate, RPA, Workato, Zapier, n8n, Airtable or Alteryx',
  is_entry_or_executive_band: 'The seat is at the analyst, associate, executive or specialist band, rather than a manager, lead, head or director seat',

  // 4. Logistics and employer shape. Cheap to ask, and each one is a filter that does not exist.
  states_salary: 'This posting states a salary, salary range or rate',
  is_fixed_term: 'This is a fixed-term or contract engagement with a stated end date or duration, rather than an open-ended permanent role',
  actually_in_singapore: 'The role is based in Singapore, rather than elsewhere or merely posted by a Singapore office',
  employer_is_small: 'The employer is a startup, small business or early-stage company rather than a large established firm',
  posted_by_agency: 'This posting is placed by a recruitment agency or staffing firm rather than by the employer who will pay the applicant',

  // 5. MLM, direct-sales and scam signals. No regex baseline worth the name: prefilter.mjs matches
  // emoji, a phrase list and a list of employer names, and its own comment concedes "a name list is
  // inherently a treadmill — these outfits rebrand — so it is here for the volume it removes today,
  // not as a permanent solution". A judgement generalises where a name list cannot, which is the
  // one place a System One model beats the rule it would replace.
  is_mlm_or_direct_sales: 'This is a multi-level marketing, network marketing or door-to-door direct sales operation, rather than a salaried role at the employer named',
  unrealistic_earnings_claim: 'This posting makes earnings claims that are implausible for the experience it asks for, or promises unusually fast promotion',
  commission_only_pay: 'Pay is commission-only, or depends on the applicant recruiting others or making sales to their own network',
  upfront_cost_to_applicant: 'The applicant is asked to pay for training, materials, certification or equipment, or to hand over identity documents or bank details before being hired',
  vague_about_the_actual_work: 'The posting avoids saying what the day-to-day work actually is, while emphasising lifestyle, mindset, travel or earnings',
  recruits_your_network: 'The role expects the applicant to sell to, or recruit from, their own friends and family',
};

// Two questions that are genuinely ordered or genuinely exclusive, so a noul would throw away what
// the primitive is for. A Score's criteria must run low to high and mean something at every step;
// a Choice's options must be mutually exclusive. Seniority band is neither, which is why
// is_entry_or_executive_band above stayed a noul.
export const SCORES = {
  archetype_fit: {
    instructions: 'How central process improvement, operations, automation or internal tooling is to this role',
    criteria: [
      'No operations, process or automation content at all',
      'Incidental operations or tooling work alongside something else',
      'Operations or automation is a named part of the role',
      'The role is primarily process automation, internal tooling or digitalisation',
    ],
  },
  marketing_adjacency: {
    instructions: 'How central marketing, communications, campaigns or growth work is to this role',
    criteria: [
      'No marketing, communications or growth content',
      'Marketing sits adjacent to the role but is not its subject',
      'Marketing, communications or growth is the core of the role',
    ],
  },
};

export const CHOICES = {
  work_arrangement: {
    instructions: 'Where the work is done',
    criteria: {
      onsite: 'Fully on-site or in-office',
      hybrid: 'A stated mix of office and home',
      remote: 'Fully remote',
      unstated: 'The posting does not say',
    },
  },
};

// The MLM question, with the criteria measured at 99% recall / 0.5% false positives on 2026-09-22
// (scripts/jev-sweep/exp-criteria.mjs). The bare version of this same question scored 63%, so the
// criteria are not decoration — they are most of the accuracy. Do not edit them without re-running
// that experiment against its control.
export const MLM_QUESTION = {
  type: 'noul',
  instructions: 'Taken together, this employer name and job title are typical of a multi-level '
    + 'marketing, network marketing or door-to-door direct sales operation rather than a salaried role',
  // ⚠ The keys are `true` and `false`. `yes`/`no` returns HTTP 400 invalid_union.
  criteria: {
    true: 'A recruitment-driven direct-sales operation. Strong tells, any one of which is enough: '
      + 'an emoji or hashtag in the job title; an employer name built from generic words like '
      + 'Org, Organization, Ventures, Holdings, Marketing Group or Marketing Solutions with no '
      + 'identifiable product; an entry-level "marketing" or "brand ambassador" title at a firm '
      + 'that markets nothing in particular; urgency or scarcity language such as URGENT, '
      + 'limited slots or immediate start; pitches aimed at fresh graduates or the recently '
      + 'discharged from national service; promises of fast promotion, travel, weekly pay or '
      + 'uncapped earnings in place of a described job',
    false: 'A salaried role at a business with an identifiable product or service, including real '
      + 'sales and marketing jobs at such businesses. A recognisable company name, a specific '
      + 'function, or a named product or platform all point here.',
  },
};
