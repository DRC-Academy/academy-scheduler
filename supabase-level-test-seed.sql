-- ─────────────────────────────────────────────────────────────────────────────
-- Seed del banco de preguntas del Test de Nivel (correr DESPUÉS de
-- supabase-level-test.sql). Preguntas ORIGINALES (no copiadas de EF SET ni otros).
--
-- ⚠️ CONTENIDO GENERADO POR IA — revisar antes de usar en producción, sobre todo
-- las `correct_answer` de B2/C1/C2. Se usa dollar-quoting ($t$…$t$) para evitar
-- problemas de escape con apóstrofes y comillas.
--
-- Idempotencia simple: se limpian las preguntas activas antes de reinsertar, así
-- correr el seed dos veces no duplica. (No borra respuestas: answers referencia
-- question_id, pero las preguntas viejas quedan huérfanas sólo si se re-seedea.)
-- ─────────────────────────────────────────────────────────────────────────────

delete from level_test_questions;

-- ══ READING — SENTENCE COMPLETION (30 · 5 por nivel) ═════════════════════════
insert into level_test_questions (section, cefr_level, difficulty, question_text, options, correct_answer) values
-- A1
($t$reading_completion$t$, $t$A1$t$, 1, $t$She ___ to school every day.$t$,               $t$["go","goes","going","gone"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$A1$t$, 1, $t$There ___ two books on the table.$t$,           $t$["is","are","am","be"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$A1$t$, 1, $t$I ___ a cup of coffee every morning.$t$,         $t$["drink","drinks","drinking","drank"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$A1$t$, 1, $t$___ you like pizza?$t$,                          $t$["Do","Does","Are","Is"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$A1$t$, 1, $t$This is ___ apple.$t$,                           $t$["a","an","the","some"]$t$::jsonb, 1),
-- A2
($t$reading_completion$t$, $t$A2$t$, 2, $t$Yesterday we ___ to the cinema.$t$,             $t$["go","went","gone","going"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$A2$t$, 2, $t$She is ___ than her brother.$t$,                 $t$["tall","taller","tallest","more tall"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$A2$t$, 2, $t$The keys are ___ the table.$t$,                  $t$["in","on","at","to"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$A2$t$, 2, $t$He ___ goes to the gym on Mondays.$t$,           $t$["usual","usually","usualy","use"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$A2$t$, 2, $t$They didn't ___ the film last night.$t$,         $t$["watched","watch","watches","watching"]$t$::jsonb, 1),
-- B1
($t$reading_completion$t$, $t$B1$t$, 3, $t$If it rains tomorrow, we ___ at home.$t$,        $t$["stay","will stay","stayed","would stay"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$B1$t$, 3, $t$I have lived here ___ 2015.$t$,                  $t$["since","for","from","during"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$B1$t$, 3, $t$You ___ see a doctor if the pain continues.$t$,  $t$["should","would","could","might"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$B1$t$, 3, $t$She has ___ finished her homework.$t$,           $t$["yet","already","still","ever"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$B1$t$, 3, $t$He asked me ___ I wanted to join.$t$,            $t$["that","if","what","which"]$t$::jsonb, 1),
-- B2
($t$reading_completion$t$, $t$B2$t$, 4, $t$The report ___ by the team last week.$t$,        $t$["wrote","was written","has written","writing"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$B2$t$, 4, $t$She said she ___ tired.$t$,                       $t$["is","was","has been","will be"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$B2$t$, 4, $t$I need to ___ this meeting; something urgent came up.$t$, $t$["call off","call on","call at","call in"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$B2$t$, 4, $t$The woman ___ car was stolen called the police.$t$, $t$["who","which","whose","that"]$t$::jsonb, 2),
($t$reading_completion$t$, $t$B2$t$, 4, $t$By the time we arrived, the film ___.$t$,        $t$["started","has started","had started","was starting"]$t$::jsonb, 2),
-- C1
($t$reading_completion$t$, $t$C1$t$, 5, $t$Not only ___ late, but he also forgot the documents.$t$, $t$["he was","was he","he is","is he"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$C1$t$, 5, $t$The committee insisted that the proposal ___ reconsidered.$t$, $t$["is","was","be","were"]$t$::jsonb, 2),
($t$reading_completion$t$, $t$C1$t$, 5, $t$Her argument was compelling, ___ some flaws in the data.$t$, $t$["despite","although","however","nevertheless"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$C1$t$, 5, $t$He has a tendency ___ conclusions too quickly.$t$, $t$["to jump to","jumping to","to jump","of jumping"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$C1$t$, 5, $t$___ harder, she would have passed the exam.$t$, $t$["If she studied","Had she studied","Should she study","Were she studying"]$t$::jsonb, 1),
-- C2
($t$reading_completion$t$, $t$C2$t$, 6, $t$The evidence was, to all ___ and purposes, conclusive.$t$, $t$["intents","intent","intends","intentions"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$C2$t$, 6, $t$She took the criticism ___ her stride.$t$,      $t$["in","on","at","with"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$C2$t$, 6, $t$The minister's remarks were widely seen as a thinly ___ threat.$t$, $t$["veiled","hidden","covered","masked"]$t$::jsonb, 0),
($t$reading_completion$t$, $t$C2$t$, 6, $t$Rarely ___ such a talented group of musicians.$t$, $t$["I have seen","have I seen","I saw","did I saw"]$t$::jsonb, 1),
($t$reading_completion$t$, $t$C2$t$, 6, $t$He agreed to help, ___ that his name be kept out of it.$t$, $t$["provided","unless","whereas","albeit"]$t$::jsonb, 0);

-- ══ READING — PASSAGES (12 · 2 por nivel) ════════════════════════════════════
insert into level_test_questions (section, cefr_level, difficulty, prompt_text, question_text, options, correct_answer) values
-- A1
($t$reading_passage$t$, $t$A1$t$, 1, $t$Tom is a nurse. He works at a hospital in the city. He starts work at 8 in the morning and finishes at 4 in the afternoon. He likes his job.$t$, $t$Where does Tom work?$t$, $t$["At a school","At a hospital","In a shop","At home"]$t$::jsonb, 1),
($t$reading_passage$t$, $t$A1$t$, 1, $t$The shop opens at 9 a.m. and closes at 6 p.m. It is closed on Sundays.$t$, $t$When is the shop closed?$t$, $t$["At 9 a.m.","On Sundays","At 6 p.m.","On Mondays"]$t$::jsonb, 1),
-- A2
($t$reading_passage$t$, $t$A2$t$, 2, $t$Last summer, Maria visited her grandparents in the countryside. She helped them in the garden and learned how to make bread. She had a wonderful time and hopes to return next year.$t$, $t$What did Maria learn to do?$t$, $t$["Ride a horse","Make bread","Paint pictures","Drive a car"]$t$::jsonb, 1),
($t$reading_passage$t$, $t$A2$t$, 2, $t$The train to Manchester leaves from platform 4 at 10:15. Passengers should arrive at least ten minutes early. Tickets can be bought online or at the station.$t$, $t$What should passengers do before the train leaves?$t$, $t$["Buy food","Arrive at least ten minutes early","Go to platform 5","Call the station"]$t$::jsonb, 1),
-- B1
($t$reading_passage$t$, $t$B1$t$, 3, $t$When Daniel started university, he found it hard to manage his time. He often stayed up late and missed morning lectures. After he began using a planner and going to bed earlier, his grades improved and he felt much less stressed.$t$, $t$What helped Daniel improve his grades?$t$, $t$["Studying at night","Skipping lectures","Planning his time and sleeping earlier","Changing universities"]$t$::jsonb, 2),
($t$reading_passage$t$, $t$B1$t$, 3, $t$The new café on Green Street has quickly become popular with students. Although the prices are slightly higher than average, customers say the quality of the coffee and the relaxed atmosphere make it worth the extra cost.$t$, $t$Why do customers like the café despite the prices?$t$, $t$["It is very cheap","The coffee quality and atmosphere","It is close to the university","It is open late"]$t$::jsonb, 1),
-- B2
($t$reading_passage$t$, $t$B2$t$, 4, $t$Remote work has changed how many companies operate. While employees often report greater flexibility and less time commuting, some managers worry that collaboration and team spirit suffer when people rarely meet in person. Finding the right balance remains a challenge.$t$, $t$What concern do some managers have about remote work?$t$, $t$["Employees work too many hours","Collaboration and team spirit may suffer","Commuting takes too long","Flexibility is too high"]$t$::jsonb, 1),
($t$reading_passage$t$, $t$B2$t$, 4, $t$The museum's latest exhibition explores the history of photography. Rather than simply displaying old cameras, it invites visitors to consider how the technology shaped the way we remember events. Critics have praised its thoughtful approach, though a few feel it relies too heavily on text.$t$, $t$What have a few critics said about the exhibition?$t$, $t$["It has too many cameras","It relies too heavily on text","It is too short","It is not about photography"]$t$::jsonb, 1),
-- C1
($t$reading_passage$t$, $t$C1$t$, 5, $t$Although the government's economic reforms were initially hailed as a bold step forward, their long-term effects have proven more ambiguous. Growth did accelerate in the first two years, but critics argue that the benefits were unevenly distributed, leaving many regions no better off than before.$t$, $t$What is the main criticism of the reforms?$t$, $t$["They caused no growth at all","Their benefits were unevenly distributed","They were introduced too slowly","They were universally rejected"]$t$::jsonb, 1),
($t$reading_passage$t$, $t$C1$t$, 5, $t$The author's central claim is that our reliance on digital devices has subtly reshaped human attention. She does not condemn technology outright; instead, she urges readers to become more deliberate about when and how they engage with it, suggesting that awareness, rather than avoidance, is the key.$t$, $t$What does the author recommend?$t$, $t$["Avoiding technology completely","Being more deliberate and aware about using it","Using devices more often","Condemning all technology"]$t$::jsonb, 1),
-- C2
($t$reading_passage$t$, $t$C2$t$, 6, $t$For all its rhetorical brilliance, the essay ultimately falls short of persuading. The author marshals an impressive array of anecdotes, yet these seldom coalesce into a coherent argument; the reader is left admiring the prose while remaining unconvinced by the thesis.$t$, $t$What is the reviewer's overall judgement of the essay?$t$, $t$["It is both well-written and convincing","It is poorly written but convincing","It is well-written but unconvincing","It has no notable qualities"]$t$::jsonb, 2),
($t$reading_passage$t$, $t$C2$t$, 6, $t$The notion that economic growth and environmental protection are inherently at odds has been challenged in recent years. Proponents of green growth contend that innovation can decouple prosperity from resource depletion, though sceptics caution that such optimism may underestimate the scale of the transformation required.$t$, $t$What do sceptics of green growth suggest?$t$, $t$["Growth and the environment can be easily reconciled","The required transformation may be underestimated","Innovation is irrelevant","Prosperity should be abandoned"]$t$::jsonb, 1);

-- ══ READING — EMAILS (12 · 2 por nivel) ══════════════════════════════════════
insert into level_test_questions (section, cefr_level, difficulty, prompt_text, question_text, options, correct_answer) values
-- A1
($t$reading_email$t$, $t$A1$t$, 1, $t$Subject: Party

Hi Anna,

My birthday party is on Saturday at 5 p.m. at my house. Please come!

Love,
Emma$t$, $t$When is the party?$t$, $t$["On Friday","On Saturday at 5 p.m.","On Sunday","At Anna's house"]$t$::jsonb, 1),
($t$reading_email$t$, $t$A1$t$, 1, $t$Subject: Lunch

Hi Ben,

Do you want to have lunch tomorrow? There is a new pizza place near the office.

See you,
Sam$t$, $t$What does Sam suggest?$t$, $t$["Having dinner","Having lunch tomorrow","Cooking at home","Going to the cinema"]$t$::jsonb, 1),
-- A2
($t$reading_email$t$, $t$A2$t$, 2, $t$Subject: Meeting change

Hi team,

The meeting on Monday is now on Tuesday at 11 a.m. in Room 3. Sorry for the change.

Thanks,
Lucy$t$, $t$What has changed about the meeting?$t$, $t$["The room only","The day and time","The topic","Nothing"]$t$::jsonb, 1),
($t$reading_email$t$, $t$A2$t$, 2, $t$Subject: Your order

Dear customer,

Thank you for your order. It will arrive within 3 to 5 working days. You will receive a message when it is sent.

Best regards,
The Shop$t$, $t$When will the customer get a message?$t$, $t$["When the order arrives","When the order is sent","After 5 days","Never"]$t$::jsonb, 1),
-- B1
($t$reading_email$t$, $t$B1$t$, 3, $t$Subject: Trip details

Hi everyone,

Just a reminder that we leave at 7 a.m. sharp on Friday. Please bring your ID and some cash, as not all places accept cards. Lunch is included, but you will need money for dinner.

Cheers,
Mark$t$, $t$What do people need money for?$t$, $t$["Lunch","Dinner","The trip ticket","The hotel"]$t$::jsonb, 1),
($t$reading_email$t$, $t$B1$t$, 3, $t$Subject: Job application

Dear Ms. Reed,

Thank you for applying. We would like to invite you to an interview next Wednesday at 10 a.m. Please reply to confirm whether the time works for you.

Kind regards,
HR Team$t$, $t$What does the HR Team ask Ms. Reed to do?$t$, $t$["Send her CV again","Confirm if the time works","Come on Thursday","Call them today"]$t$::jsonb, 1),
-- B2
($t$reading_email$t$, $t$B2$t$, 4, $t$Subject: Budget review

Hi Team,

After reviewing last quarter's figures, I think we should shift part of the print advertising budget towards digital channels. Our online campaigns delivered a much higher return, and the trend is likely to continue. Please look at the attached data and share your thoughts by Thursday.

Best,
Mark$t$, $t$What does Mark propose?$t$, $t$["Increasing the total budget","Moving budget from print to digital","Stopping all advertising","Waiting until next year"]$t$::jsonb, 1),
($t$reading_email$t$, $t$B2$t$, 4, $t$Subject: Feedback on draft

Hi Sara,

Thanks for the report. Overall it is strong, but the conclusion feels rushed and does not fully reflect the findings in section 3. Could you expand it before we send it to the client? No need to change anything else.

Regards,
Tom$t$, $t$What does Tom want Sara to do?$t$, $t$["Rewrite the whole report","Expand the conclusion","Delete section 3","Send it to the client now"]$t$::jsonb, 1),
-- C1
($t$reading_email$t$, $t$C1$t$, 5, $t$Subject: Partnership proposal

Dear Mr. Alvarez,

While we remain enthusiastic about a potential collaboration, we have reservations about the proposed timeline, which we feel is overly ambitious given the resources currently available. We would welcome the opportunity to discuss a more phased approach at your earliest convenience.

Sincerely,
Dana Whitfield$t$, $t$What is Dana's main concern?$t$, $t$["The cost of the project","The proposed timeline is too ambitious","The lack of enthusiasm","The choice of partner"]$t$::jsonb, 1),
($t$reading_email$t$, $t$C1$t$, 5, $t$Subject: Re: Complaint

Dear Ms. Boyle,

We sincerely apologise for the inconvenience caused. While our policy does not normally allow refunds after 30 days, we are prepared to make an exception in your case as a gesture of goodwill. A full refund will be processed within five working days.

Yours faithfully,
Customer Care$t$, $t$Why is the company offering a refund?$t$, $t$["It is required by their standard policy","As an exception, as a gesture of goodwill","Because the product was faulty","Because Ms. Boyle asked twice"]$t$::jsonb, 1),
-- C2
($t$reading_email$t$, $t$C2$t$, 6, $t$Subject: Editorial decision

Dear Dr. Nunes,

Having consulted our reviewers, we regret that we are unable to accept your manuscript in its present form. The central hypothesis is intriguing, but the methodology raises concerns that, in our view, undermine the reliability of the conclusions. We would, however, be open to reconsidering a substantially revised version.

With regards,
The Editors$t$, $t$What is the editors' position on the manuscript?$t$, $t$["They accept it as it is","They reject it permanently","They may reconsider a heavily revised version","They only object to its length"]$t$::jsonb, 2),
($t$reading_email$t$, $t$C2$t$, 6, $t$Subject: Restructuring

Dear colleagues,

I will not dress this up: the coming months will be demanding. The restructuring, though painful, is intended to secure the firm's long-term viability rather than to deliver short-term savings. I ask for your patience and candour as we navigate what will inevitably be an uncomfortable transition.

Regards,
The Director$t$, $t$What is the stated purpose of the restructuring?$t$, $t$["To cut costs quickly","To secure long-term viability","To reduce the number of meetings","To reward staff"]$t$::jsonb, 1);

-- ══ WRITING (6 · 1 por nivel) ════════════════════════════════════════════════
insert into level_test_questions (section, cefr_level, difficulty, writing_prompt, writing_min_words, writing_evaluation_criteria) values
($t$writing$t$, $t$A1$t$, 1, $t$Write 3–5 sentences introducing yourself. Include your name, where you are from, and what you do.$t$, 30, $t${"grammar":"Present simple and basic sentence structure","vocabulary":"Basic personal-information vocabulary","coherence":"Simple, clear sentences","task_completion":"Covers name, origin and occupation"}$t$::jsonb),
($t$writing$t$, $t$A2$t$, 2, $t$Write a short message to a colleague to change the time of a meeting. Explain the new time and apologise for the change.$t$, 50, $t${"grammar":"Simple present/past and basic requests","vocabulary":"Everyday work vocabulary","coherence":"Logical short message","task_completion":"States the new time and apologises"}$t$::jsonb),
($t$writing$t$, $t$B1$t$, 3, $t$Write an email to a friend describing your last holiday. Say where you went, what you did, and whether you would recommend it.$t$, 80, $t${"grammar":"Past tenses and basic connectors","vocabulary":"Travel and leisure vocabulary","coherence":"Organised with connectors","task_completion":"Covers all three points"}$t$::jsonb),
($t$writing$t$, $t$B2$t$, 4, $t$Write a formal email applying for a job you are interested in. Explain why you are suitable and request an interview.$t$, 120, $t${"grammar":"A range of structures and formal register","vocabulary":"Professional vocabulary","coherence":"Clear paragraphs","task_completion":"States suitability and requests an interview"}$t$::jsonb),
($t$writing$t$, $t$C1$t$, 5, $t$Write an opinion essay on the statement: Working from home is better than working in an office. Discuss both sides and give your opinion.$t$, 180, $t${"grammar":"Complex structures and cohesion devices","vocabulary":"Precise, varied vocabulary","coherence":"Balanced argument with a clear stance","task_completion":"Discusses both sides and gives an opinion"}$t$::jsonb),
($t$writing$t$, $t$C2$t$, 6, $t$Write a critical analysis of the following statement: Globalisation inevitably erodes local cultures. Present a nuanced argument supported by examples.$t$, 250, $t${"grammar":"Sophisticated, accurate structures","vocabulary":"Idiomatic and academic vocabulary","coherence":"Well-developed, nuanced argumentation","task_completion":"Presents a nuanced, well-supported argument"}$t$::jsonb);
