import type { DiagramText } from "./types";

export const gull: DiagramText = {
  id: "gull",
  title: "Gull",
  model: { species: "American Herring Gull", age: "adult", pose: "standing" },
  intro:
    "Drawn from an adult American Herring Gull. Adult gulls are told apart mostly by the shade of gray above, the wingtip pattern, and the colours of the bill, legs and eye. Immature gulls look very different and take two to four years to reach adult plumage.",
  sources: [
    {
      label: "Herring Gull Very Close.jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Herring_Gull_Very_Close.jpg",
      credit: "Chuck Homler d/b/a Focus On Wildlife, CC BY-SA 4.0",
    },
    { label: "American herring gull (Wikipedia)", url: "https://en.wikipedia.org/wiki/American_herring_gull" },
    { label: "Ring-billed gull (Wikipedia)", url: "https://en.wikipedia.org/wiki/Ring-billed_gull" },
    { label: "California gull (Wikipedia)", url: "https://en.wikipedia.org/wiki/California_gull" },
    { label: "Gonys (Wikipedia)", url: "https://en.wikipedia.org/wiki/Gonys" },
    { label: "Covert feather (Wikipedia)", url: "https://en.wikipedia.org/wiki/Covert_feather" },
  ],
  parts: [
    // Head
    {
      id: "forehead",
      name: "Forehead",
      group: "Head",
      lookFor: "A gently sloping or a steep forehead changes the head shape, one of the structural clues for large gulls.",
    },
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor: "White on this adult Herring Gull in breeding plumage; some gulls have a dark hood instead. In winter, many adults get brown streaks on the head, and the pattern differs between species.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "On winter Herring Gulls and many other large gulls, head streaking is often heaviest here and on the hindneck.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor: "Between the eye and the bill; white on this adult Herring Gull.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor: "Behind the eye. A dark smudge here in winter is typical of some species.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor: "Below the bill; white on this adult Herring Gull.",
    },
    {
      id: "orbital-ring",
      name: "Orbital ring",
      group: "Head",
      lookFor:
        "A thin ring of bare skin around the eye. Its colour helps with adults: yellow to orange on an adult Herring Gull, red on adult Ring-billed and California Gulls.",
      visibility: "Thin; best seen up close or through a scope.",
    },
    {
      id: "iris",
      name: "Iris",
      group: "Head",
      lookFor: "Eye colour: pale yellow on most adult Herring Gulls, dark on adult California Gulls.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor: "Note its size and colour, and how heavy it looks against the head. Adult Herring Gulls have a stout yellow bill.",
    },
    {
      id: "gonys",
      name: "Gonys",
      group: "Bill & legs",
      lookFor:
        "The ridge under the lower mandible, from its tip back to the gonydeal angle, where the bill's lower edge bends. A strong angle makes the bill look deep-tipped and heavy; a slight one makes it look slim.",
    },
    {
      id: "gonydeal-spot",
      name: "Gonydeal spot",
      group: "Bill & legs",
      lookFor:
        "A spot on the lower mandible at the gonys angle. Adult Herring Gulls have a red one; not all gulls do, and an adult Ring-billed Gull has a black ring around the bill instead.",
    },
    {
      id: "legs",
      name: "Legs and feet",
      group: "Bill & legs",
      lookFor: "Pink on an adult Herring Gull, yellow on an adult Ring-billed Gull. Leg colour is one of the quickest checks on adults.",
    },
    // Upperparts
    {
      id: "mantle",
      name: "Mantle",
      group: "Upperparts",
      lookFor:
        "Strictly, the mantle is the upper back, but in gull identification 'mantle colour' means the gray upperparts as a whole: back, scapulars and wing coverts. Its shade, from pale silver to nearly black, is one of the main marks for adult gulls.",
    },
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "The upper body between the neck and the folded wings; the same gray as the rest of the upperparts on this adult.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers over the top of the folded wing. On many adults their white tips form a scapular crescent.",
    },
    // Wing
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor: "Gray on this adult. On immature large gulls the covert pattern is one of the main ways to judge age.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor: "The middle row of coverts. Gray on this adult; on immature Herring Gulls and many other large gulls they are patterned brown.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The longest row of coverts, just above the secondaries. Gray on this adult; on immature Herring Gulls and many other large gulls they are patterned brown.",
    },
    {
      id: "secondaries",
      name: "Secondaries (skirt)",
      group: "Wing",
      lookFor:
        "Their white tips make the white trailing edge of the wing in flight. On a standing gull they can show below the coverts as a white 'skirt'.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "The innermost flight feathers, lying over the rear of the folded wing. Their white tips make the tertial crescent.",
    },
    {
      id: "tertial-crescent",
      name: "Tertial crescent",
      group: "Wing",
      lookFor: "The white crescent formed by the tertial tips, just above the wingtip. How broad it is differs between species.",
    },
    {
      id: "primaries",
      name: "Primaries (wingtip)",
      group: "Wing",
      lookFor:
        "The wingtip pattern: how much black, and the size and number of white spots. An adult Herring Gull's wingtips are black with white spots.",
    },
    {
      id: "apical-spots",
      name: "Apical spots",
      group: "Wing",
      lookFor: "Small white tips to the primaries, visible on the folded wingtip. They wear away, so they're smallest by late summer.",
    },
    {
      id: "mirrors",
      name: "Mirrors",
      group: "Wing",
      lookFor:
        "White spots in the black near the tips of the outermost primaries, set in from the tip (unlike apical spots). Their number and size help separate adult gulls.",
      visibility: "Mostly hidden on a standing gull, so the circle shows the wingtip spread open, with the outermost primaries (where mirrors sit) at the bottom; seen in flight or when a gull stretches.",
    },
    // Underparts
    {
      id: "breast",
      name: "Breast",
      group: "Underparts",
      lookFor: "White on this adult. Immature Herring Gulls are mottled brown, and some species, such as Heermann's Gull, are gray below even as adults.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "White on this adult Herring Gull.",
    },
    {
      id: "sides",
      name: "Sides",
      group: "Underparts",
      lookFor: "The sides of the body below the folded wing; white on this adult.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "White on this adult; barred on many immature large gulls.",
    },
    // Tail
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor: "White on this adult Herring Gull, though a few species, such as Heermann's Gull, have dark tails as adults. Immature Herring Gulls have dark tail bands, and the tail pattern helps tell age and species in many gulls.",
      visibility: "Largely hidden under the wingtips on a standing gull. Drawn a little larger here so it's easy to find.",
    },
  ],
};
