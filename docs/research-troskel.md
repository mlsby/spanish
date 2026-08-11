# Research: var ska "kan det"-gränsen gå? (2026-08-11)

Frågan: dagens nivåband är Övar < 7 d · På gång 7–30 d · Kan det ≥ 30 d
(stabilitet, båda riktningarna). Är 30 rätt?

## Vad stabiliteten betyder (FSRS)

Stabilitet S = antal dagar tills sannolikheten att minnas sjunkit till 90 %.
Glömskekurvan är flack (potenskurva): R(t) = (1 + 0,235·t/S)^−0,5.
Så här mycket minns man **90 dagar** efter senaste repetition:

| Stabilitet | Minns efter 90 d |
|---|---|
| 14 d | ~63 % |
| 21 d | ~71 % |
| 30 d | ~77 % |

Skillnaden 21→30 är alltså ~6 procentenheter i långtidsretention — inte en
klippkant. Gränsen är kosmetisk; schemaläggningen påverkas inte alls.

## Vad andra använder

| System | "Kan"-gräns | Kommentar |
|---|---|---|
| Anki | **mature ≥ 21 d** intervall | branschkonventionen sedan decennier; "young/mature" i all statistik |
| WaniKani | Guru = 1 v (räknas som "lärd", låser upp nästa), Master = 1 mån, Burned = ~6 mån | trappa av etiketter, inte en gräns |
| Memrise | "learned" direkt efter första inlärningscykeln | ren korttidsstämpel — det vi INTE vill |
| SuperMemo/FSRS | ingen gräns alls | kunskap är ett kontinuum; band är UI-val |

## Det praktiska argumentet (viktigast!)

Med rätt-svar-kedjan växer stabiliteten ungefär 3 → 9 → **25** → 60 dagar.
Tredje lyckade repetitionen landar på ~25 d:

- **Gräns 21 d:** ordet blir grönt vid tredje repetitionen — dag ~12–14.
- **Gräns 30 d:** 25 < 30 ⇒ ordet missar med en hårsmån och får vänta en
  HEL cykel till — grönt först dag ~37–40.

30-dagarsgränsen råkar alltså ligga precis ovanför det naturliga
tredje-repetitionssteget. Det är därför det känns så segt: en enda
procentenhets ärlighet kostar tre veckors upplevd stiltje.

## Rekommendation

- **Kan det: stabilitet ≥ 21 d** (Anki-mature). Grönt vid tredje lyckade
  repetitionen (~2 veckor), fortfarande äkta långtidsminne (~71 % efter
  3 månader utan repetition).
- **På gång: 7–21 d**, Övar < 7 d — oförändrade i praktiken.
- Manuella markeringar (✓/stegen "Kan det") sätter samma värde som gränsen
  (21 d istället för 30) så att "kollas ärligt vid nästa rep" består.
- Kravet "båda riktningarna" behålls — det är vår verkliga kvalitetsspärr.

Källor: [Anki-manualen (statistik)](https://docs.ankiweb.net/stats.html) ·
[Expertium: Understanding retention in FSRS](https://expertium.github.io/Retention.html) ·
[Expertium: A technical explanation of FSRS](https://expertium.github.io/Algorithm.html) ·
[WaniKani SRS stages](https://knowledge.wanikani.com/wanikani/srs-stages/) ·
[Memrise-recension (learned-stämpeln)](https://www.studyfrenchspanish.com/memrise-review/)
