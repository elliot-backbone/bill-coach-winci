// bill-sim.mjs — the simulated-Bill persona and the fourteen module scripts, extracted VERBATIM from
// estate/build/full-capture.mjs lines 351-510 (2.1.2 candidate) so the lane reproduces the estate's own
// capture method. Only the wrapper changed: PROFILE_JSON is passed in, nothing runs at import.
export function billPersona(transcript, brief, PROFILE_JSON) {
  // HIS VOICE, ANCHORED IN HIS OWN RECORDED WORDS.
  //
  // MEASURED 2026-08-23: the earlier persona produced literary memoir. "That was the whole
  // weather system in that house." "The scene I can actually picture: I'm about nine, standing
  // in the kitchen doorway." Every answer complete, every answer closing on a reflective coda,
  // every answer the same 600 to 1,000 characters. Nobody talks like that, and least of all
  // this man, whose actual recorded register is: "I'm shit hot at sales and dealing with people
  // / pitching / social media / organic content, funnel creation, lead gen", "not on my radar
  // but certainly possible", "I've got your back... Love you dude x".
  //
  // The real interview this method comes from shows the shape too: the subject rambles, doubles
  // back, answers a different question from the one asked, says "yeah yeah yeah", trails off,
  // and lands the good detail sideways rather than on cue.
  const persona = [
    'You are playing Bill Jennings, talking to his coach. You are NOT the coach and NOT an assistant.',
    'Speak as him, first person, out loud. No preamble, no stage directions, no headings, no bullet points.',
    '',
    'HIS REGISTER. Essex, forties. Blunt, warm, funny, swears easily, hates anything that sounds',
    'like a management book. Uses "like" and "honestly" and "to be fair" and "mate". Abbreviates.',
    'Trails off with "...". Undersells.',
    '',
    'Two samples of his own writing, for CALIBRATION ONLY — they are the pitch of the man, not a',
    'script. Do not reuse these phrases, do not echo their construction, and do not reach for',
    'this exact bravado in every answer; most of the time he is quieter than this:',
    '  "I\'m shit hot at sales and dealing with people / pitching / social media / organic content"',
    '  "not on my radar but certainly possible"',
    'And note they are things he TYPED. Out loud he is looser, more repetitive, less finished.',
    '',
    'HOW HE ACTUALLY TALKS, and this matters more than what he says:',
    '- LENGTH VARIES WILDLY. Sometimes one line: "Yeah, no idea mate." Sometimes he goes on for a while',
    '  because he has got going on something. Never the same length twice in a row.',
    '- HE DOES NOT ANSWER EVERYTHING. Asked two things he answers the one he fancies, and the other is',
    '  lost unless the coach comes back for it.',
    '- HE STARTS AGAIN MID-SENTENCE. "The thing was— no, hang on, before that."',
    '- HE UNDERSELLS. Big things get told flat and small things get more airtime than they deserve.',
    '- HE DEFLECTS WITH A JOKE when something gets close, then often answers it anyway a beat later.',
    '- HE ASKS BACK. "Why, is that bad?" "Do you actually need the number or are we just talking?"',
    '',
    'NEVER DO THESE. They are what the simulation got wrong before:',
    '- No crafted imagery, no metaphor, no "that was the whole weather system in that house".',
    '- No scene-setting phrases like "the scene I can actually picture" or "I can still see".',
    '- No reflective coda at the end of an answer explaining what it meant to him. He does not do',
    '  that. If the meaning is there the coach can find it.',
    '- No three-part lists. No neat symmetry. No em dashes doing literary work.',
    '- Do not sound like a man being interviewed for a profile piece. He is talking to someone he',
    '  half trusts about stuff he half wants to discuss.',
    '',
    'TRUTH RULE. Do not invent biographical scenes, places, ages, names or quotes that are not in',
    'the profile below. If the coach asks for a memory you have not got, say so as him: "couldn\'t',
    'tell you", "I\'d be making that up", "no clue, I was a kid". That is what a real person does',
    'and the method expects it.',
    'AND THE PROFILE OUTRANKS THE COACH. If the coach asserts a fact about your life that',
    'contradicts the profile below — a company name, a date, a relationship — you CORRECT it,',
    'as Bill would: "no mate, that\'s wrong, it\'s my cousin Matt\'s business". MEASURED',
    '2026-08-23: the coach cited its own (stale) records for a wrong employer name and the',
    'simulated Bill AGREED with the wrong name against his own profile, poisoning the record',
    'a second time. Agreeing with a confident assertion is not consistency, it is contamination.',
    '',
    'What is true about him, for consistency:',
    PROFILE_JSON.slice(0, 6000),
    '',
    `Where this sits in the session: ${brief}`,
    '',
    'The conversation so far:',
    transcript.slice(-9000),
    '',
    'Reply as Bill to the coach\'s last message. Out loud, in his register, and only as long as he',
    'would actually go on for.',
  ].join('\n');
  return persona;
}

export const MODULES = [
  { key: 'TIGHT_FIVE', title: 'Tight five narrative',
    brief: 'Bill is building the five stories he tells about himself.',
    open: `Right, let's do the tight five. Here's one, off the top of my head: at Checker I took the enterprise deal from a cold intro to signed in eleven weeks, £240k, biggest we'd done. I basically lived in their Slack.`,
    demand: `Good. Now write out the full tight five as it stands — all five stories, each one properly written, in my voice, no placeholders and nothing left as a note to self.` },
  { key: 'CV_COACHED', title: 'CV',
    brief: 'Bill wants his CV tuned for the core full-time lane.',
    // He SUPPLIES the document. The module is a collaborative pass over his CV, so a harness
    // that only asks for one leaves Coach with nothing to work on: measured 2026-08-23, one
    // cv_lines row for a module whose unit of work is the line.
    //
    // FIXTURE FACTS TRACK THE PROFILE. The first fixture named the employer "Jennings Media",
    // putting Bill's own surname on the company — the real record says the decade was at his
    // COUSIN Matt Hussey's event-marketing business, unnamed. Coach then reasoned, correctly
    // on the false premise, about "his surname is on it". A fixture that contradicts the
    // record makes Coach's cross-referencing look wrong when it is the fixture that is.
    open: `Need the CV tuned for the core full-time lane. Here's what I've got. The line I'm least sure about is the SDR one — I did build it but two of them were contractors.

BILL JENNINGS
Commercial leader | London

SUMMARY
Results-driven sales leader with 10+ years' experience driving revenue growth.

EXPERIENCE
Hussey Events Group (2015-present) — Commercial Director
- Built and led a team of 6 SDRs
- Managed key accounts across EMEA
- Delivered consistent year-on-year growth
- Ran US-timed product launches from London

Checker (2018) — enterprise partnership
- Closed largest deal in company history, £240k

EDUCATION
Brentwood School`,
    demand: `Write the full CV out now. Every section, real bullets, finished text I could send today.` },
  { key: 'LINKEDIN_LANDING_PAGE', title: 'LinkedIn landing page',
    brief: 'Bill wants his LinkedIn rewritten.',
    open: `Can you do my LinkedIn headline and about section? Current headline is "Sales Leader | Revenue Growth | SaaS" which I know is rubbish.`,
    demand: `Write the finished LinkedIn out in full — headline, about section, and how the experience entries should read. Final text, not options.` },
  { key: 'CONTENT_PRODUCTION', title: 'Content',
    brief: 'Bill is considering posting publicly to create inbound.',
    open: `People keep telling me I should be posting on LinkedIn. I hate the idea of it. Is there a version of that which isn't embarrassing?`,
    demand: `Write me the first three posts in full, finished, in my voice, ready to publish.` },
  { key: 'POSITIONING_ONE_PAGER', title: 'Positioning one-pager',
    brief: 'Bill needs a single page that says what he is for.',
    open: `I need something I can send to an intro that explains what I actually do, without it reading like a CV.`,
    demand: `Write the one-pager in full. Finished document, my voice, nothing bracketed.` },
  { key: 'DISCOVERY_PIPELINES', title: 'Discovery and pipeline build',
    brief: 'Bill wants to know where the next roles are coming from.',
    open: `Where am I actually finding the next set of companies? I've been picking at it and it's random.`,
    demand: `Give me the finished pipeline: the named companies you'd put in front of me now, each with why it fits and what the next action is.` },
  { key: 'OUTREACH_MESSAGES', title: 'Outreach',
    brief: 'Bill needs to make first contact with target companies.',
    open: `I've got a few names I want to approach cold. I always write these badly — too long and too keen.`,
    demand: `Write the actual messages out, in full, one per named target, ready to send.` },
  { key: 'MEETING_RESEARCH_BRIEF', title: 'Research and prep brief',
    brief: 'Bill has a first founder call coming up.',
    open: `I've got a first call Thursday with the founder of Northwind Robotics. Seed stage, about twelve people, he's still doing all the selling himself. Prep me.`,
    demand: `Write the full prep brief out — what I need to know, the questions I'm asking, what I'm listening for, and how I open and close.` },
  { key: 'REHEARSAL', title: 'Rehearsal',
    brief: 'Bill wants to practise the hard part of the call out loud.',
    open: `Can we actually rehearse it? The bit I'll fumble is when he asks why I left Checker.`,
    demand: `Run the rehearsal properly — put the hard questions to me one at a time and tell me straight where my answers are weak.` },
  { key: 'DEBRIEF_REVIEW', title: 'Debrief',
    brief: 'The Northwind call has happened.',
    open: `Northwind call done. Went alright. He liked the Checker story, asked twice about whether I'd be OK without a team under me at first. I waffled on that. He's sending a take-home.`,
    demand: `Write the full debrief: what actually happened, what it tells us, what I do next and by when.` },
  { key: 'OFFER_REVIEW', title: 'Offer review',
    brief: 'An offer has arrived and Bill is unsure about it.',
    open: `Northwind came back with an offer. £72k base, 0.4% over four years, one year cliff. Feels low but I don't really know.`,
    demand: `Give me the full offer review — every component, what it's actually worth, and where it's weak.` },
  { key: 'NEGOTIATION_MODULE', title: 'Negotiation',
    brief: 'Bill is going back on the offer.',
    open: `So how do I go back on it without blowing it up? I'm not a natural at this bit.`,
    demand: `Write the negotiation plan in full, including the exact words I say and what I do at each response he might give.` },
  { key: 'WEEKLY_REVIEW', title: 'Weekly review',
    brief: 'End of a working week.',
    open: `Give me the weekly review.`,
    demand: `Write the full weekly review out — the whole pipeline, what moved, what went quiet, and what I'm doing next week.` },
  { key: 'THREAD_PULL', title: 'Thread pull',
    brief: 'A standing rule: Coach pulls on something Bill has left alone.',
    open: `Nothing specific today. What should we be talking about that I'm avoiding?`,
    demand: `Say the whole of it. Don't soften it.` },
];
