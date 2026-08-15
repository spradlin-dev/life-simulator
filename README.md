# Pip — a little critter

A tiny canvas creature that reacts to your cursor. It wanders, gets curious
about a cursor that holds still, follows one it trusts, flees sudden
movement, and falls asleep when nothing happens. No goal — just watch a
personality emerge from a few if-statements.

Live at: https://spradlin-dev.github.io/life-simulator/

## Run it

    npm install
    npm run dev

## How it works

The whole personality lives in `src/brain.ts` as pure functions: three mood
dials (fear, curiosity, trust) and one `chooseState()` full of if-statements.
`src/main.ts` wires it to the browser — cursor sensing, movement, canvas
drawing, and the HUD. `npm test` runs the personality tests.

Pushing to `main` lints, builds, tests, and deploys to GitHub Pages.
