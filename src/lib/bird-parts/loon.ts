import type { DiagramText } from "./types";

export const loon: DiagramText = {
  id: "loon",
  title: "Loon",
  model: { species: "Common Loon", age: "adult, breeding", pose: "swimming" },
  intro:
    "Drawn from an adult Common Loon (in Europe, the Great Northern Diver) in breeding plumage, swimming low in the water. Loons (divers) dive for fish, driven by big webbed feet set far back on the body. A breeding Common Loon has a black head, a striped necklace and a checkered back; in winter, loons turn dark grey above and white below and look much more alike. Look at the bill and how it's held, the head and neck pattern, the back, and the flanks at the waterline.",
  sources: [
    {
      label: "GNLoon WhiteLake1.JPG (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:GNLoon_WhiteLake1.JPG",
      credit: "Mykola Swarnyk, CC BY-SA 3.0",
    },
    {
      label: "Gavia immer4 BS.jpg (reference photo for the head and neck, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Gavia_immer4_BS.jpg",
      credit: "Cephas, CC BY-SA 3.0",
    },
    {
      label: "Common Loon in Flight - Gavia immer (27909754751).jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Common_Loon_in_Flight_-_Gavia_immer_(27909754751).jpg",
      credit: "Glacier National Park (NPS), public domain",
    },
    { label: "Common loon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Common_loon" },
    { label: "Loon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Loon" },
    { label: "Red-throated loon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Red-throated_loon" },
    { label: "Black-throated loon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Black-throated_loon" },
    { label: "Pacific loon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Pacific_loon" },
    { label: "Yellow-billed loon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Yellow-billed_loon" },
    { label: "Common Loon (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/common-loon" },
    { label: "Red-throated Loon (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/red-throated-loon" },
    { label: "Pacific Loon (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/pacific-loon" },
    { label: "Arctic Loon (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/arctic-loon" },
    { label: "Yellow-billed Loon (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/yellow-billed-loon" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor:
        "Black with a green, purple or blue sheen on a breeding Common Loon, which usually has a steep forehead and a bulging forecrown. A breeding Pacific Loon has a grey head; a Red-throated Loon's is dark grey.",
    },
    {
      id: "face",
      name: "Face",
      group: "Head",
      lookFor:
        "Black, with a red eye, on a breeding Common Loon. In winter its eye is ringed with white; a Pacific Loon shows less white around the eye than a Common or Red-throated Loon, and a winter Red-throated Loon has much of its face white.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor:
        "Black on a breeding Common Loon. A breeding Arctic Loon (Black-throated Diver) has a grey head and hindneck, and a Red-throated Loon has narrow black and white stripes down the back of its neck.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor:
        "Black on a breeding Common Loon. The throat names two of its relatives: a Red-throated Loon has a triangular red throat patch, and an Arctic Loon (Black-throated Diver) a black throat and foreneck. A Pacific Loon's black throat has a purple gloss; in Alaska an Arctic Loon's shows a green one. In winter the throat is white on all of them; a winter Common Loon's white foreneck usually makes a notch into the dark side of the neck.",
    },
    {
      id: "throat-streaks",
      name: "Throat streaks",
      group: "Head",
      lookFor: "A short bar of white streaks across the upper foreneck, under the chin, above the necklace.",
      visibility: "Small: easiest to pick from the list.",
    },
    {
      id: "necklace",
      name: "Necklace",
      aka: "collar",
      group: "Head",
      lookFor:
        "On a breeding Common Loon, a collar of white parallel lines forming a large oval on each side of the black neck. A breeding Arctic Loon (Black-throated Diver) has about five long white lines down each side of its throat instead. Winter Common Loons may show a faint trace of it.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Every loon has a spear-shaped bill. A Common Loon's is heavy and dagger-like, evenly tapered: black in breeding plumage, mostly pale grey with a dark ridge and tip in winter. A Yellow-billed Loon (White-billed Diver) has a very heavy pale bill whose lower edge angles up to the tip, and often swims with it pointed slightly up. A Red-throated Loon's thin bill is slightly upturned at the tip and often held angled up.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "lower leg",
      group: "Bill & legs",
      lookFor:
        "Pale grey on the inner half and blackish on the outer half. A loon's legs are set far back on its body, ideal for swimming but clumsy for walking, so loons come ashore only to mate and nest.",
      visibility: "Under the water on a swimming bird; seen in flight from below.",
    },
    {
      id: "toes",
      name: "Toes",
      group: "Bill & legs",
      lookFor:
        "Big and webbed, with flesh-coloured webs. A loon chases fish underwater driven mainly by its feet. A grebe's toes are not joined by webs.",
      visibility: "Under the water on a swimming bird. In flight the feet trail behind the tail.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor:
        "Checkered black and white on a breeding Common Loon; Pacific and Arctic Loons are checkered too. A Red-throated Loon is the only loon with an all-dark back in breeding plumage. In winter a Common Loon is dark brownish grey above, and a young bird's back has a pale scaly pattern.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor:
        "Shoulder feathers with big white squares, part of the checkered back. A winter Common Loon keeps only a faint pattern of squares here; an Arctic Loon has a few rows of high-contrast white squares.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "Blackish, like the rest of the upperparts.",
      visibility: "Seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The rows of smaller feathers covering the wing, shown here as one area. Blackish with small white spots on a Common Loon, except the primary coverts.",
      visibility: "Seen in flight. On a swimming loon the spotted coverts are usually covered by the body feathers.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor: "The small feathers at the front of the wing.",
      visibility: "Seen in flight.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor: "The middle row of coverts.",
      visibility: "Seen in flight.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The longest row of coverts, just above the secondaries.",
      visibility: "Seen in flight.",
    },
    {
      id: "primary-coverts",
      name: "Primary coverts",
      group: "Wing",
      lookFor: "Coverts lying over the bases of the primaries, on the hand. Plain blackish on a Common Loon.",
      visibility: "Seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Seen in flight.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "The innermost flight feathers, next to the body.",
      visibility: "Seen in flight from above.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor: "The flight feathers of the inner wing.",
      visibility: "Seen in flight.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the hand. A loon's wings are small for its heavy body, so most loons run across the water to take off; only the Red-throated Loon can take off from land. A Common Loon flies with its neck stretched out and its head a little lower than its body; a Red-throated Loon droops its head and neck further, looking hunchbacked, with quicker, deeper wingbeats.",
      visibility: "Seen in flight.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor: "White on a Common Loon, so the underwing looks paler than the upperwing.",
      visibility: "Seen in flight from below.",
    },
    {
      id: "axillaries",
      name: "Axillaries",
      aka: "wingpits",
      group: "Wing",
      lookFor: "Feathers in the 'armpit', where the underwing meets the body. White with long black shaft streaks on a Common Loon.",
      visibility: "Seen in flight from below.",
    },
    // Underparts
    {
      id: "breast",
      name: "Breast",
      group: "Underparts",
      lookFor:
        "Pure white. Beside it, the white lines on the lower sides of a breeding Common Loon's neck break up into rows of small spots.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor:
        "Dark, spotted with white, on this Common Loon. On the very similar Arctic and Pacific Loons, look here: an Arctic Loon shows a white patch above the waterline on its rear flanks, which a Pacific Loon lacks.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "Pure white on a Common Loon, in every season.",
      visibility: "Under the water on a swimming bird; seen in flight from below.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "White with some black on a Common Loon, the only black on its white underparts.",
      visibility: "Under the water on a swimming bird; seen in flight from below.",
    },
    // Tail
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor: "Blackish. A loon swims very low, sometimes with only its head above the water.",
    },
  ],
};
