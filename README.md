# Pip — a little critter

A tiny canvas creature that reacts to you — cursor on desktop, touch on
mobile. It wanders, gets curious about a watcher that holds still, follows
one it trusts, flees sudden movement, and falls asleep when nothing happens.
No goal — just watch a personality emerge from a few if-statements.

Your pip is saved in your browser — the same individual, and how much
it trusts you, will be there when you come back.

It remembers. Scares leave lasting marks on its temperament and on the
places where they happened; warmth — treats, snuggles, good days —
slowly writes over them. A patient keeper can rehabilitate a scarred
pip, and every pip ends up with favorite corners.

Live at: https://spradlin-dev.github.io/life-simulator/

## Run it

    npm install
    npm run dev

## How it works

The whole personality lives in `src/brain.ts` as pure functions: three mood
dials (fear, curiosity, trust) and one `chooseState()` full of if-statements.
`src/input.ts` turns mouse and touch into the same senses — on touch, a
lifted finger leaves a fading "ghost" the critter can still investigate, a
quick tap is a knock (scary up close, intriguing from afar), and a long
press reads as holding still. `src/main.ts` wires it all to the browser —
movement, canvas drawing, and the HUD. `npm test` runs the personality tests.

Pushing to `main` lints, builds, tests, and deploys to GitHub Pages.
