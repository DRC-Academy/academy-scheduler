-- ─────────────────────────────────────────────────────────────────────────────
-- Ampliación del banco de preguntas del Test de Nivel: +42 preguntas.
--
-- POR QUÉ 42. `npm run check:bank` exige, en CADA una de las seis dificultades,
-- tantas preguntas como preguntas tenga el bloque. No es un margen de seguridad:
-- en las dificultades 1 y 6 el clamp del algoritmo deja al alumno clavado (en 6,
-- acertar te deja en 6), así que un C2 puede consumir el bloque ENTERO en
-- dificultad 6. Como la dificultad se arrastra entre bloques, puede llegar a
-- textos ya clavado arriba. Faltaban:
--
--   Completar oraciones (bloque de 6):  5 por nivel →  6   =  6 preguntas
--   Comprensión de textos (bloque de 5): 2 por nivel →  5   = 18 preguntas
--   Comprensión de emails (bloque de 5): 2 por nivel →  5   = 18 preguntas
--                                                            ──────────────
--                                                              42
--
-- Sin esto, a los alumnos fuertes se les acaban las preguntas difíciles, reciben
-- las de la dificultad de al lado y el nivel medido sale por debajo del real.
-- Medido sobre los 13 tests reales: 7 de 13 convergían en dificultad ≥5 con más
-- del 75 % de acierto, o sea que el escalón quería subir y el banco no le dejaba.
--
-- ⚠️ CONTENIDO GENERADO POR IA, igual que el seed original. Las preguntas están
-- construidas para que solo una opción sea defendible, pero REVISA las
-- `correct_answer` antes de darlas por buenas, sobre todo de B2 para arriba. Una
-- clave mal puesta no da error: baja el nivel de todos los que acierten de verdad.
--
-- ── Diferencias con supabase-level-test-seed.sql ─────────────────────────────
-- Este script es ADITIVO. El seed original empieza con `delete from
-- level_test_questions`, que hoy YA NO SE PUEDE CORRER: la clave foránea de
-- level_test_answers.question_id no lleva `on delete`, así que ese DELETE falla
-- en cuanto existe una sola respuesta guardada. Aquí no se borra nada.
--
-- Es idempotente: cada fila se inserta solo si no hay ya una con el mismo par
-- (prompt_text, question_text). Correrlo dos veces no duplica.
--
-- Ejecutalo UNA vez en el SQL editor de Supabase y después comprobá con
-- `npm run check:bank`, que tiene que salir en verde y con código 0.
-- ─────────────────────────────────────────────────────────────────────────────

-- ══ COMPLETAR ORACIONES — 1 por nivel (5 → 6) ═══════════════════════════════
insert into level_test_questions (section, cefr_level, difficulty, question_text, options, correct_answer)
select v.section, v.cefr_level, v.difficulty, v.question_text, v.options, v.correct_answer
from (values
  ($t$reading_completion$t$, $t$A1$t$, 1, $t$I go to work ___ bus.$t$,
    $t$["by","in","on","with"]$t$::jsonb, 0),
  ($t$reading_completion$t$, $t$A2$t$, 2, $t$Look! It ___ outside.$t$,
    $t$["rains","rained","is raining","rain"]$t$::jsonb, 2),
  ($t$reading_completion$t$, $t$B1$t$, 3, $t$If I ___ more time, I would travel more.$t$,
    $t$["have","had","will have","having"]$t$::jsonb, 1),
  ($t$reading_completion$t$, $t$B2$t$, 4, $t$I'd rather you ___ tell anyone about this.$t$,
    $t$["don't","won't","haven't","didn't"]$t$::jsonb, 3),
  ($t$reading_completion$t$, $t$C1$t$, 5, $t$The results were ___ short of remarkable.$t$,
    $t$["nothing","none","nowhere","never"]$t$::jsonb, 0),
  ($t$reading_completion$t$, $t$C2$t$, 6, $t$He has an irritating habit of ___ hairs.$t$,
    $t$["cutting","dividing","splitting","breaking"]$t$::jsonb, 2)
) as v(section, cefr_level, difficulty, question_text, options, correct_answer)
where not exists (
  select 1 from level_test_questions q
  where coalesce(q.prompt_text, '') = ''
    and coalesce(q.question_text, '') = v.question_text
);

-- ══ COMPRENSIÓN DE TEXTOS — 3 por nivel (2 → 5) ═════════════════════════════
insert into level_test_questions (section, cefr_level, difficulty, prompt_text, question_text, options, correct_answer)
select v.section, v.cefr_level, v.difficulty, v.prompt_text, v.question_text, v.options, v.correct_answer
from (values
  -- A1
  ($t$reading_passage$t$, $t$A1$t$, 1,
    $t$Anna has a small dog. Its name is Coco. Coco is black and white. Anna walks with Coco in the park every evening.$t$,
    $t$When does Anna walk her dog?$t$,
    $t$["In the morning","At lunchtime","Every evening","On Saturdays"]$t$::jsonb, 2),
  ($t$reading_passage$t$, $t$A1$t$, 1,
    $t$The library is next to the school. It opens at ten o'clock. You can borrow five books. You must bring them back after two weeks.$t$,
    $t$How many books can you borrow?$t$,
    $t$["Two","Five","Ten","Twelve"]$t$::jsonb, 1),
  ($t$reading_passage$t$, $t$A1$t$, 1,
    $t$My name is Kenji. I am from Japan, but I live in London now. I am a student and I study music.$t$,
    $t$What does Kenji study?$t$,
    $t$["Japanese","English","Science","Music"]$t$::jsonb, 3),
  -- A2
  ($t$reading_passage$t$, $t$A2$t$, 2,
    $t$Sofia moved to a new flat last month. It is smaller than her old one, but it is much closer to her office, so she walks to work now instead of taking the bus.$t$,
    $t$How does Sofia get to work now?$t$,
    $t$["By bus","On foot","By car","By train"]$t$::jsonb, 1),
  ($t$reading_passage$t$, $t$A2$t$, 2,
    $t$The football match will start at seven o'clock, but the gates open at half past five. Fans are asked to arrive early because the car park is very small.$t$,
    $t$Why are fans asked to arrive early?$t$,
    $t$["There is not much parking","The match may start sooner","Tickets are cheaper before six","The gates close at half past five"]$t$::jsonb, 0),
  ($t$reading_passage$t$, $t$A2$t$, 2,
    $t$Last winter we went skiing for the first time. On the first day I fell over many times, but by the end of the week I could go down the easy slopes without any help.$t$,
    $t$What could the writer do at the end of the week?$t$,
    $t$["Teach other beginners","Ski down the hardest slopes","Ski down the easy slopes alone","Ski without ever falling"]$t$::jsonb, 2),
  -- B1
  ($t$reading_passage$t$, $t$B1$t$, 3,
    $t$Marta had always wanted to run a marathon, but she never found the time. When her company introduced flexible working hours, she began training three mornings a week before work. Eighteen months later she finished her first race.$t$,
    $t$What finally made it possible for Marta to train?$t$,
    $t$["Joining a running club","Moving closer to work","Taking a long holiday","A change to her working hours"]$t$::jsonb, 3),
  ($t$reading_passage$t$, $t$B1$t$, 3,
    $t$The council has closed the main street to cars on Saturdays. Shop owners objected strongly at first, but after three months most of them report that more customers are coming in on foot.$t$,
    $t$How has the shop owners' opinion changed?$t$,
    $t$["They object even more strongly now","They are more positive than before","Their view has not changed at all","They want the street closed every day"]$t$::jsonb, 1),
  ($t$reading_passage$t$, $t$B1$t$, 3,
    $t$People often assume that learning an instrument is harder for adults than for children. In fact, adults usually progress faster at the start because they understand the theory behind what they are playing, although they tend to have less time to practise.$t$,
    $t$According to the text, what helps adult learners at the beginning?$t$,
    $t$["They understand the theory","They have more free time","They have better memories","They practise more often"]$t$::jsonb, 0),
  -- B2
  ($t$reading_passage$t$, $t$B2$t$, 4,
    $t$The company's decision to publish every employee's salary was controversial. Supporters argued it would close the pay gap; critics warned it would breed resentment. Two years on, pay differences have narrowed, but staff turnover has risen sharply.$t$,
    $t$What does the text suggest about the policy?$t$,
    $t$["It was abandoned after two years","It achieved everything its supporters hoped for","It has produced mixed results","It was welcomed by almost everyone"]$t$::jsonb, 2),
  ($t$reading_passage$t$, $t$B2$t$, 4,
    $t$Urban beekeeping has grown rapidly, yet ecologists caution that adding hives to a city does not automatically help biodiversity. Honeybees compete for food with wild pollinators, many of which are already under considerable pressure.$t$,
    $t$What concern do the ecologists raise?$t$,
    $t$["City honey is of poor quality","Beekeeping has become too expensive","There are too few trained beekeepers","Honeybees compete with wild pollinators"]$t$::jsonb, 3),
  ($t$reading_passage$t$, $t$B2$t$, 4,
    $t$When the factory closed, the town lost a quarter of its jobs almost overnight. What eventually revived it was not another large employer but dozens of small businesses, a good number of them started by former factory workers.$t$,
    $t$What brought the town back?$t$,
    $t$["The arrival of a new large employer","Many small businesses","A government investment programme","A growth in tourism"]$t$::jsonb, 1),
  -- C1
  ($t$reading_passage$t$, $t$C1$t$, 5,
    $t$Critics of the scheme have concentrated almost exclusively on its cost, an emphasis that is understandable but rather misses the point. The question is not whether the programme is expensive; it is whether any cheaper alternative would achieve as much.$t$,
    $t$What is the writer's view of the critics?$t$,
    $t$["They are addressing the wrong question","They have misread the financial figures","They are right to focus on the cost","They secretly support the scheme"]$t$::jsonb, 0),
  ($t$reading_passage$t$, $t$C1$t$, 5,
    $t$The archive was assembled with such evident care that its omissions become conspicuous. Nothing here has been left out by accident: every absence is a decision, and the decisions, taken together, tell a story of their own.$t$,
    $t$What does the writer imply about the archive?$t$,
    $t$["It was put together carelessly","It is too large to be useful","Its gaps are deliberate and revealing","It contains a great deal of irrelevant material"]$t$::jsonb, 2),
  ($t$reading_passage$t$, $t$C1$t$, 5,
    $t$For decades the received wisdom held that the ruins were a temple. Recent excavation has turned up no trace whatsoever of ritual activity, and a growing number of specialists now favour a far more prosaic explanation: a storehouse.$t$,
    $t$Why have specialists changed their minds?$t$,
    $t$["New written records came to light","The dating method proved unreliable","A second site was discovered nearby","No evidence of ritual use was found"]$t$::jsonb, 3),
  -- C2
  ($t$reading_passage$t$, $t$C2$t$, 6,
    $t$It would be too generous to call the argument circular; a circle at least returns to where it began. This one merely wanders, gathering assertions as it goes and mistaking their accumulation for proof.$t$,
    $t$What is the writer's objection to the argument?$t$,
    $t$["It repeats the same point endlessly","It piles up claims and treats them as proof","It leans too heavily on statistics","It is far too brief to convince anyone"]$t$::jsonb, 1),
  ($t$reading_passage$t$, $t$C2$t$, 6,
    $t$Her reputation rests, somewhat unfairly, on a single early novel. The later work is more ambitious and, in places, considerably better, but it lacks the one quality that carried the first book so far: it is not quotable.$t$,
    $t$Why, according to the writer, is the later work less celebrated?$t$,
    $t$["It offers no memorable lines","It appeared too long after the first","It is markedly weaker than the first novel","It was never widely reviewed"]$t$::jsonb, 0),
  ($t$reading_passage$t$, $t$C2$t$, 6,
    $t$The policy has been defended on the grounds that it is popular. Popularity, however, is a measure of assent rather than of wisdom, and the two coincide rather less often than politicians find convenient.$t$,
    $t$What point is the writer making?$t$,
    $t$["Popular policies are invariably mistaken","Politicians should pay less attention to voters","Public approval is no guarantee that a policy is sound","Wise policies are almost always unpopular"]$t$::jsonb, 2)
) as v(section, cefr_level, difficulty, prompt_text, question_text, options, correct_answer)
where not exists (
  select 1 from level_test_questions q
  where coalesce(q.prompt_text, '') = v.prompt_text
    and coalesce(q.question_text, '') = v.question_text
);

-- ══ COMPRENSIÓN DE EMAILS — 3 por nivel (2 → 5) ═════════════════════════════
insert into level_test_questions (section, cefr_level, difficulty, prompt_text, question_text, options, correct_answer)
select v.section, v.cefr_level, v.difficulty, v.prompt_text, v.question_text, v.options, v.correct_answer
from (values
  -- A1
  ($t$reading_email$t$, $t$A1$t$, 1,
    $t$Subject: Cinema

Hi Sam,
Do you want to see a film on Friday? The film starts at eight o'clock. We can meet outside the cinema at half past seven.
Ben$t$,
    $t$What time will they meet?$t$,
    $t$["Seven o'clock","Half past seven","Eight o'clock","Half past eight"]$t$::jsonb, 1),
  ($t$reading_email$t$, $t$A1$t$, 1,
    $t$Subject: Keys

Hello Ana,
I am at the office today. Your keys are on the kitchen table. See you at six.
Mum$t$,
    $t$Where are the keys?$t$,
    $t$["At the office","In Ana's bag","On her desk","On the kitchen table"]$t$::jsonb, 3),
  ($t$reading_email$t$, $t$A1$t$, 1,
    $t$Subject: Bus

Hi Leo,
The school bus is late today. It will arrive at half past eight, not at eight o'clock. Please wait at the bus stop.
Mr Diaz$t$,
    $t$What is the problem?$t$,
    $t$["The bus is late","The bus is full","There is no bus today","The bus stop has changed"]$t$::jsonb, 0),
  -- A2
  ($t$reading_email$t$, $t$A2$t$, 2,
    $t$Subject: Football practice

Hi everyone,
Practice on Wednesday is cancelled because the pitch is flooded. We will train on Thursday at the same time instead. Please bring warm clothes.
Coach Ana$t$,
    $t$Why is Wednesday's practice cancelled?$t$,
    $t$["The coach is ill","There are not enough players","The pitch is flooded","Thursday is a holiday"]$t$::jsonb, 2),
  ($t$reading_email$t$, $t$A2$t$, 2,
    $t$Subject: Book club

Dear members,
This month we are reading a short novel instead of the usual long one, because several of you said you had very little free time in December. We will meet on the 18th as always.
Rosa$t$,
    $t$Why did they choose a short novel?$t$,
    $t$["Members have little free time","The long book was too expensive","The library had no copies","The meeting will be shorter"]$t$::jsonb, 0),
  ($t$reading_email$t$, $t$A2$t$, 2,
    $t$Subject: New neighbours

Hi Tom,
A family moved into the flat upstairs on Saturday. They have two young children and a very friendly cat. I met them in the lift and they seem nice.
Paula$t$,
    $t$Where did Paula meet the new neighbours?$t$,
    $t$["In their flat","In the street","At the school","In the lift"]$t$::jsonb, 3),
  -- B1
  ($t$reading_email$t$, $t$B1$t$, 3,
    $t$Subject: Course places

Dear applicant,
Thank you for your interest in the photography course. All the places for the spring term have now been filled, but we run the same course again in September and we would be happy to keep your name on the list.
Admissions$t$,
    $t$What is the writer telling the applicant?$t$,
    $t$["The course has been cancelled","The spring course is full but there is another one later","The application arrived too late to be considered","The course fee has gone up"]$t$::jsonb, 1),
  ($t$reading_email$t$, $t$B1$t$, 3,
    $t$Subject: Delivery problem

Hello,
Your parcel was returned to us because nobody was at the address on two separate occasions. We can send it again free of charge if you give us a delivery date, or refund you in full. Please let us know which you would prefer.
Customer Service$t$,
    $t$What does the company ask the customer to do?$t$,
    $t$["Collect the parcel from the depot","Pay a second delivery charge","Choose between a new delivery and a refund","Confirm that the address is correct"]$t$::jsonb, 2),
  ($t$reading_email$t$, $t$B1$t$, 3,
    $t$Subject: Volunteering

Hi Marco,
Thanks for offering to help at the festival. We have plenty of people for Saturday, but we are short of volunteers for Sunday morning, when the tents have to be taken down. Could you manage that instead?
Lucia$t$,
    $t$What does Lucia want Marco to do?$t$,
    $t$["Help on Sunday rather than Saturday","Find more volunteers himself","Arrive earlier on the Saturday","Bring equipment to the festival"]$t$::jsonb, 0),
  -- B2
  ($t$reading_email$t$, $t$B2$t$, 4,
    $t$Subject: Revised timeline

Hi all,
Following yesterday's meeting, we are pushing the launch back by three weeks. This is not a reaction to the testing results, which were largely positive, but to the supplier's inability to confirm delivery dates. I would rather move the date once than move it twice.
Helena$t$,
    $t$Why has the launch been delayed?$t$,
    $t$["The test results were disappointing","The team asked for more time","The budget has not been approved","The supplier cannot confirm delivery dates"]$t$::jsonb, 3),
  ($t$reading_email$t$, $t$B2$t$, 4,
    $t$Subject: Your article

Dear Ms Ferrer,
We enjoyed your piece on urban transport and would like to publish it, subject to one change: the section on cycling repeats material we ran last month. If you could replace it with something on bus networks, we can go ahead.
The Editor$t$,
    $t$What is the condition for publication?$t$,
    $t$["The article must be made shorter","One section must be replaced","The tone must be made less critical","The sources must be checked again"]$t$::jsonb, 1),
  ($t$reading_email$t$, $t$B2$t$, 4,
    $t$Subject: Office move

Team,
The move to the third floor will happen over the weekend of the 14th. You do not need to pack your computers, but anything left on desks or windowsills will be thrown away, so please take personal items home on the Friday.
Facilities$t$,
    $t$What are staff asked to do?$t$,
    $t$["Pack up their own computers","Come in over the weekend to help","Take personal items home before the weekend","Work from home on the 14th"]$t$::jsonb, 2),
  -- C1
  ($t$reading_email$t$, $t$C1$t$, 5,
    $t$Subject: Funding decision

Dear Dr Okonkwo,
The panel found your proposal original and carefully argued, and it was ranked well within the top quartile. Regrettably, the budget available this round allowed us to fund only six of the thirty-one applications received. I would encourage you to resubmit in the autumn.
Grants Office$t$,
    $t$Why was the proposal not funded?$t$,
    $t$["There was not enough money to fund all the strong applications","The panel found weaknesses in the argument","It was submitted after the deadline","It fell outside the panel's priorities"]$t$::jsonb, 0),
  ($t$reading_email$t$, $t$C1$t$, 5,
    $t$Subject: Re: your complaint

Dear Mr Alvarez,
I have now listened to the recording of your call. While our adviser followed the procedure correctly at every step, I accept that the procedure itself gave you no realistic way of resolving the matter, and that is our failing rather than hers. We are revising it.
Head of Service$t$,
    $t$What does the writer conclude?$t$,
    $t$["The adviser behaved unprofessionally","The complaint had no real foundation","The recording was inconclusive","The procedure, not the adviser, was at fault"]$t$::jsonb, 3),
  ($t$reading_email$t$, $t$C1$t$, 5,
    $t$Subject: Speaking invitation

Dear Professor Lind,
We would be delighted if you would open the conference. I should be candid: we cannot match the fee you received last year, and the slot is early on the Saturday morning. What we can offer is an audience of people who have actually read your work.
Organising Committee$t$,
    $t$How does the writer present the invitation?$t$,
    $t$["As a formality that needs no reply","Frankly, acknowledging its drawbacks","As an offer better than last year's","As something the professor has already accepted"]$t$::jsonb, 1),
  -- C2
  ($t$reading_email$t$, $t$C2$t$, 6,
    $t$Subject: Manuscript

Dear Ms Bahr,
I have read the manuscript twice, the second time hoping to be persuaded. The prose is faultless and the research beyond reproach, and yet I closed it without any clear sense of what you wanted me to take away. That, I think, is what stands between this and publication.
Commissioning Editor$t$,
    $t$What is the editor's central criticism?$t$,
    $t$["The writing is careless in places","The research has not been properly verified","The book lacks a clear central point","The subject will interest very few readers"]$t$::jsonb, 2),
  ($t$reading_email$t$, $t$C2$t$, 6,
    $t$Subject: Restructure, second thoughts

Dear Board,
I supported the merger of the two departments and I still believe the logic was sound. What I underestimated was how much of the work depended on relationships that the new structure quietly dissolved. The saving is real; so is the cost, and it does not appear anywhere in the accounts.
The Director$t$,
    $t$What is the writer acknowledging?$t$,
    $t$["A real cost of the change that the figures do not show","That the logic of the merger was mistaken","That the savings were deliberately overstated","That the board was not properly consulted"]$t$::jsonb, 0),
  ($t$reading_email$t$, $t$C2$t$, 6,
    $t$Subject: Reference

Dear Ms Whitlock,
You ask for my frank assessment. Daniel is the most capable analyst I have worked with and the least willing to be managed. In a team that genuinely values autonomy he will be an asset; in one that does not, he will be a problem, and I would not want you to discover that after appointing him.
R. Sen$t$,
    $t$What is the writer doing in this reference?$t$,
    $t$["Recommending Daniel without reservation","Advising against appointing Daniel","Declining to give a real opinion","Warning that Daniel's suitability depends on the team"]$t$::jsonb, 3)
) as v(section, cefr_level, difficulty, prompt_text, question_text, options, correct_answer)
where not exists (
  select 1 from level_test_questions q
  where coalesce(q.prompt_text, '') = v.prompt_text
    and coalesce(q.question_text, '') = v.question_text
);

-- ── Comprobación ─────────────────────────────────────────────────────────────
-- Tiene que devolver 6 preguntas activas en cada dificultad de completar
-- oraciones y 5 en cada dificultad de textos y de emails. Si algo sale por
-- debajo, `npm run check:bank` lo dirá con más detalle.
select section, difficulty, count(*) as preguntas
from level_test_questions
where is_active is not false
group by section, difficulty
order by section, difficulty;
