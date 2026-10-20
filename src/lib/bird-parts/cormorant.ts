import type { DiagramText } from "./types";

export const cormorant: DiagramText = {
  id: "cormorant",
  title: "Cormorant",
  model: { species: "Double-crested Cormorant", age: "adult breeding", pose: "perched" },
  intro:
    "Drawn from an adult Double-crested Cormorant in breeding plumage, the most widespread cormorant in North America and the only one likely to be seen inland in most areas. Cormorants and their relatives, the Anhinga, gannets and boobies, pelicans and frigatebirds, have all four toes joined by webs, and most have bare skin on the throat. Look at the colour and shape of the bare skin on the face and throat, the bill, the length of the tail, and the shape of the neck in flight.",
  sources: [
    {
      label: "Double-crested Cormorant (Nannopterum auritum), Windsor, Ontario, 2025-07-05.jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Double-crested_Cormorant_(Nannopterum_auritum),_Windsor,_Ontario,_2025-07-05.jpg",
      credit: "Crisco 1492, CC BY-SA 4.0",
    },
    {
      label: "Cormorant over Fremont Cut 2017-12-30 -04 (hard crop, bluer).jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Cormorant_over_Fremont_Cut_2017-12-30_-04_(hard_crop,_bluer).jpg",
      credit: "Joe Mabel, CC BY-SA 4.0",
    },
    { label: "Double-crested cormorant (Wikipedia)", url: "https://en.wikipedia.org/wiki/Double-crested_cormorant" },
    { label: "Cormorant (Wikipedia)", url: "https://en.wikipedia.org/wiki/Cormorant" },
    { label: "Gular skin (Wikipedia)", url: "https://en.wikipedia.org/wiki/Gular_skin" },
    { label: "Webbed foot (Wikipedia)", url: "https://en.wikipedia.org/wiki/Webbed_foot" },
    { label: "Anhinga (Wikipedia)", url: "https://en.wikipedia.org/wiki/Anhinga" },
    { label: "Brown pelican (Wikipedia)", url: "https://en.wikipedia.org/wiki/Brown_pelican" },
    { label: "Double-crested Cormorant (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/double-crested-cormorant" },
    { label: "Neotropic Cormorant (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/neotropic-cormorant" },
    { label: "Great Cormorant (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/great-cormorant" },
    { label: "Brandt's Cormorant (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/brandts-cormorant" },
    { label: "Pelagic Cormorant (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/pelagic-cormorant" },
    { label: "Anhinga (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/anhinga" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor: "Black on an adult Double-crested Cormorant; brownish on a young bird.",
    },
    {
      id: "crests",
      name: "Crests",
      group: "Head",
      lookFor:
        "The two tufts the Double-crested Cormorant is named for, one above each eye. They are white or partly white on most western birds and black on eastern ones, and even in the breeding season they rarely stand out in the field.",
      visibility: "Breeding season only.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "The back of the head: black on an adult, like the rest of the head and neck.",
    },
    {
      id: "face",
      name: "Face",
      group: "Head",
      lookFor: "The feathered side of the head, black on an adult. The bright colour on a cormorant's face is bare skin, not feathers.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor:
        "Bare orange skin runs from the bill up to the front of the eye. It is brightest on a breeding adult and more yellowish outside the breeding season. In many cormorants the bare face skin is blue, orange, red or yellow, typically brightest in the breeding season.",
    },
    {
      id: "gular-skin",
      name: "Gular skin",
      aka: "throat pouch",
      group: "Head",
      lookFor:
        "The bare skin under the bill, joining it to the neck: orange on a Double-crested Cormorant. Its colour and shape tell cormorants apart. A Neotropic Cormorant's is duller and yellowish, with a pointed back edge (rounded on a Double-crested). An adult Great Cormorant's is yellow, with a broad white band behind it, and a breeding Brandt's Cormorant's turns blue, though it is hard to see. Pelicans scoop up fish in a huge pouch of the same skin.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Hooked at the tip. Dark on an adult Double-crested Cormorant and mostly orange or yellowish on a young bird. The Anhinga, which looks like a cormorant when perched, has a straight, dagger-pointed bill with no hook.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "lower leg",
      group: "Bill & legs",
      lookFor: "Short. A Double-crested Cormorant chases fish underwater, driven mainly by its feet.",
    },
    {
      id: "toes",
      name: "Toes",
      group: "Bill & legs",
      lookFor:
        "All four toes are joined by webs (a 'totipalmate' foot). A duck or gull has webs between its three front toes only. Cormorants share this foot with the Anhinga, gannets and boobies, pelicans, frigatebirds and tropicbirds.",
      visibility: "In flight from below, the big webbed feet show beside the tail.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "Each feather has a dark grayish centre and a black edge on an adult, so the back looks scaly.",
      visibility: "Covered by the folded wings on a perched cormorant; seen in flight from above.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers lying over the base of each wing, scaly like the back.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "Between the back and the tail; black on this adult.",
      visibility: "Covered by the wings on a perched cormorant; seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The rows of smaller feathers covering the wing, shown here as one area. On an adult Double-crested Cormorant each has a dark grayish centre and a black edge, so the folded wing looks scaly against the black body.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor: "The small feathers at the front of the wing.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor: "The middle row of coverts.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The longest row of coverts, just above the secondaries.",
    },
    {
      id: "primary-coverts",
      name: "Primary coverts",
      group: "Wing",
      lookFor: "Coverts lying over the bases of the primaries, on the hand.",
      visibility: "Hidden on a perched cormorant; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Hidden on a perched cormorant; seen in flight.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor: "The flight feathers of the inner wing; black on an adult.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "The innermost flight feathers, lying over the rear of the folded wing.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the hand. After fishing, cormorants often perch with their wings held open; a study of the Great Cormorant found the pose dries the feathers.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor: "The feathers covering the underside of the wing in front of the flight feathers.",
      visibility: "Seen in flight, or when a bird holds its wings open.",
    },
    {
      id: "axillaries",
      name: "Axillaries",
      aka: "wingpits",
      group: "Wing",
      lookFor: "Feathers in the 'armpit', where the underwing meets the body.",
      visibility: "Seen in flight, or when a bird holds its wings open.",
    },
    // Underparts
    {
      id: "neck",
      name: "Neck",
      group: "Underparts",
      lookFor:
        "Long and thin. A swimming cormorant sits low, often with only its head and neck showing. In flight a Double-crested Cormorant holds its neck with a slight crook just behind the head; most cormorants look straight-necked in flight.",
    },
    {
      id: "breast",
      name: "Breast",
      group: "Underparts",
      lookFor:
        "Black on an adult. A young Double-crested Cormorant is paler on the foreneck and breast, often fading to whitish there. A young Great Cormorant usually has a brown neck and breast, contrasting with a white belly.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor: "Black on an adult Double-crested Cormorant. Breeding Great and Pelagic Cormorants grow white patches here.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "Black on an adult, like the rest of the underparts.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the base of the tail.",
    },
    // Tail
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Medium-length on a Double-crested Cormorant. A Neotropic Cormorant's is distinctly longer, and an Anhinga's is longer and fan-shaped, spread wide when it soars.",
    },
  ],
};
