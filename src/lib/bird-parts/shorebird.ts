import type { DiagramText } from "./types";

export const shorebird: DiagramText = {
  id: "shorebird",
  title: "Shorebird",
  model: { species: "Lesser Yellowlegs", age: "adult", pose: "standing" },
  intro:
    "Drawn from an adult Lesser Yellowlegs. With shorebirds, structure comes first: bill length and shape, leg length and colour, and how far the wings reach.",
  sources: [
    {
      label: "Lesser yellowlegs (32690).jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Lesser_yellowlegs_(32690).jpg",
      credit: "Rhododendrites, CC BY-SA 4.0",
    },
    { label: "Lesser yellowlegs (Wikipedia)", url: "https://en.wikipedia.org/wiki/Lesser_yellowlegs" },
    { label: "Flight feather: primary projection (Wikipedia)", url: "https://en.wikipedia.org/wiki/Flight_feather" },
    { label: "Covert feather (Wikipedia)", url: "https://en.wikipedia.org/wiki/Covert_feather" },
    { label: "Bird anatomy (Wikipedia)", url: "https://en.wikipedia.org/wiki/Bird_anatomy" },
  ],
  parts: [
    // Head
    {
      id: "forehead",
      name: "Forehead",
      group: "Head",
      lookFor: "Just above the bill. A steep or gently sloping forehead changes the look of the whole head.",
    },
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor: "The top of the head. Look for a capped look, with the crown darker or more streaked than the face.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "The back of the head where it meets the neck. Fine streaks here often fade into a plainer back.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor: "A pale stripe above the eye. Note whether it's bold or faint, and whether it stops at the eye or runs well behind it.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor: "Between the eye and the bill. Many shorebirds have a dark stripe here; whether it reaches the bill is worth a look.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor: "A pale ring around the eye. On some species, such as Solitary Sandpiper, a bold white eye-ring is a key mark.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor: "Behind and below the eye. A darker patch here adds to the face pattern.",
    },
    {
      id: "chin",
      name: "Chin",
      group: "Head",
      lookFor: "Just below the bill; usually pale and unmarked.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor: "Below the chin. Note where the streaking of the breast begins.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Judge its length against the head and note its shape: straight, drooping or upturned. A Lesser Yellowlegs' straight bill is about as long as its head; a Greater Yellowlegs' is longer.",
    },
    {
      id: "legs",
      name: "Legs and feet",
      group: "Bill & legs",
      lookFor: "Leg colour (yellow, greenish, black) and leg length are often the quickest clues. The yellowlegs are named for theirs.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "The upper body above the folded wings. Read its pattern together with the scapulars.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor:
        "Shoulder feathers covering the top of the folded wing. Their pattern (dark centres, pale spots or edges) helps separate species and ages.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor: "The rows of feathers lying over the bases of the flight feathers: the lesser, median and greater coverts.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor: "The small coverts at the front of the folded wing.",
      visibility: "Often partly hidden by the breast and scapulars at rest.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor:
        "The middle row of coverts. On juvenile shorebirds the coverts have neat pale edges that give a scaly look, a good way to age them in late summer and fall.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The longest row of coverts, closest to the flight feathers.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "The innermost flight feathers, lying on top of the folded wing. Their tips are the starting point for judging primary projection.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor: "The long outer flight feathers. On a standing bird, their tips form the wingtip.",
    },
    {
      id: "primary-projection",
      name: "Primary projection",
      group: "Wing",
      lookFor:
        "How far the primaries extend beyond the tertials on the folded wing. It's usually judged against the length of the tertials themselves, e.g. about half their length.",
    },
    {
      id: "wingtip-vs-tail",
      name: "Wingtip vs. tail",
      group: "Wing",
      lookFor:
        "Whether the folded wingtips fall short of the tail tip, reach it, or pass it. Baird's and White-rumped Sandpipers have wingtips well past the tail; a Least Sandpiper's don't reach beyond it.",
    },
    // Underparts
    {
      id: "breast",
      name: "Breast",
      group: "Underparts",
      lookFor: "Note streaks, spots or a band across the breast, and where the markings stop.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "Usually the palest area. In breeding plumage a few species, such as Dunlin, show a dark belly patch.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor: "The sides of the body. Bars or chevrons here show on many shorebirds in breeding plumage.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "Under the base of the tail. Usually white on shorebirds.",
    },
    // Tail
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor: "Note its pattern when the bird flies: bars, a dark centre or white sides.",
      visibility: "Mostly covered by the folded wings at rest.",
    },
  ],
};
