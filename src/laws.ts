// the world's constitution: what each world PROMISES, held as data so the
// biology stays one law everywhere and only the contract differs. Dials are
// levers a keeper may turn; laws are what a world will not break. The meadow
// is the care game — a floor under every rescue, and no meadow stays empty.
// The terrarium is the full-real lab: no floor, and extinction sticks.
export interface WorldLaws {
  // a collapsed pip can always be roused by food inside this range, however
  // deep its torpor; 0 leaves nature to decide
  rescueFloor: number;
  // seed a new founder when the last pip is gone
  reseedOnEmpty: boolean;
}

export const LAWS: Record<'meadow' | 'terrarium', WorldLaws> = {
  meadow: { rescueFloor: 120, reseedOnEmpty: true },
  terrarium: { rescueFloor: 0, reseedOnEmpty: false },
};
