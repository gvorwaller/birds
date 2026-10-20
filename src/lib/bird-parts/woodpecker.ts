import type { DiagramText } from "./types";

export const woodpecker: DiagramText = {
  id: "woodpecker",
  title: "Woodpecker",
  model: { species: "Downy Woodpecker", age: "adult male", pose: "clinging to a trunk" },
  intro:
    "Drawn from an adult male Downy Woodpecker clinging to a trunk, with a close-up of a foot. Woodpeckers climb trunks propped on a stiff tail, gripping with two toes forward and two back. The Downy is the smallest woodpecker in North America: black above with a white back, white below, with white spots on the wings and one white bar above the eye and one below. Look at the bill against the head, the face stripes, the back, the wing spots and the outer tail feathers.",
  sources: [
    {
      label: "20240325 downy woodpecker earle park PD206065.jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:20240325_downy_woodpecker_earle_park_PD206065.jpg",
      credit: "Paul Danese, CC BY-SA 4.0",
    },
    {
      label: "Picoides pubescens m CT.jpg (reference photo for the male's red patch, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Picoides_pubescens_m_CT.jpg",
      credit: "Cephas, CC BY-SA 3.0",
    },
    {
      label: "Hairy woodpecker m To ON flight.jpg (reference photo for the upperwing in flight, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Hairy_woodpecker_m_To_ON_flight.jpg",
      credit: "Mykola Swarnyk, CC BY-SA 3.0",
    },
    {
      label: "Downy Woodpecker 5600 (6215343900).jpg (reference photo for the underwing, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Downy_Woodpecker_5600_(6215343900).jpg",
      credit: "Robert Taylor, CC BY 2.0",
    },
    { label: "Downy woodpecker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Downy_woodpecker" },
    { label: "Hairy woodpecker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Hairy_woodpecker" },
    { label: "Woodpecker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Woodpecker" },
    { label: "Ladder-backed woodpecker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Ladder-backed_woodpecker" },
    { label: "Nuttall's woodpecker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Nuttall%27s_woodpecker" },
    { label: "Red-bellied woodpecker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Red-bellied_woodpecker" },
    { label: "Red-headed woodpecker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Red-headed_woodpecker" },
    { label: "Yellow-bellied sapsucker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Yellow-bellied_sapsucker" },
    { label: "Northern flicker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Northern_flicker" },
    { label: "Pileated woodpecker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Pileated_woodpecker" },
    { label: "Great spotted woodpecker (Wikipedia)", url: "https://en.wikipedia.org/wiki/Great_spotted_woodpecker" },
    { label: "Downy Woodpecker (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/downy-woodpecker" },
    { label: "Hairy Woodpecker (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/hairy-woodpecker" },
    { label: "Downy Woodpecker (National Geographic)", url: "https://www.nationalgeographic.com/animals/birds/facts/downy-woodpecker" },
    { label: "Another clue for identifying Downy and Hairy Woodpeckers (Sibley Guides)", url: "https://sibleyguides.com/?p=4924" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor:
        "Black on a Downy Woodpecker. A male Red-bellied Woodpecker's red cap runs from the bill to the nape, a Red-headed Woodpecker's whole head is red, and a male Ladder-backed or Nuttall's Woodpecker has a red crown.",
    },
    {
      id: "nape-patch",
      name: "Nape patch",
      aka: "nuchal patch",
      group: "Head",
      lookFor:
        "The male Downy's small red patch on the back of the head; females lack it, and a young Downy has red on the centre of the crown instead. On a male Hairy Woodpecker the red is usually split by a black line down the middle, where a male Downy's patch is usually solid, though not always. A male Great Spotted Woodpecker of Europe also has a red nape patch.",
      visibility: "Males only.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor:
        "Black on a Downy. A Nuttall's Woodpecker has solid black at the top of its back, where a Ladder-backed Woodpecker's barring runs up to the nape.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor: "The white bar above the eye. A Downy has one white bar above the eye and one below, with black between them.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "ear patch",
      group: "Head",
      lookFor: "The black band behind the eye on a Downy, between its two white bars.",
    },
    {
      id: "submoustachial",
      name: "Submoustachial stripe",
      group: "Head",
      lookFor: "The white bar below the eye on a Downy, between the black ear patch and the malar stripe.",
    },
    {
      id: "malar",
      name: "Malar stripe",
      aka: "moustache",
      group: "Head",
      lookFor:
        "The black stripe from the base of the bill along the side of the throat. A Hairy Woodpecker shows a bigger wedge of black from the back of it onto the breast. On a male Northern Flicker it is black in the East and red in the West, and females lack it; a male Pileated Woodpecker's is red.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor: "White on a Downy. A male Yellow-bellied Sapsucker has a red throat; a female's is white.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "A woodpecker's strong bill has a chisel-like tip for drilling and drumming. It is the best way to tell a Downy from a Hairy Woodpecker: a Downy's bill is much shorter than its head, while a Hairy's is about as long as its head.",
    },
    {
      id: "nasal-tufts",
      name: "Nasal tufts",
      group: "Bill & legs",
      lookFor:
        "Feathers over the nostrils at the base of the bill. A woodpecker's nostrils are often slit-like, with special feathers covering them. A Downy's pale nasal tuft looks large for its short bill, compared with a Hairy's.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "leg",
      group: "Bill & legs",
      lookFor: "Short and strong, as on most birds that feed on tree trunks.",
    },
    {
      id: "toes",
      name: "Toes",
      group: "Bill & legs",
      lookFor:
        "Two toes face forward and two back (zygodactyl feet), a good grip on a trunk. A few woodpeckers, such as the American Three-toed and Black-backed Woodpeckers, have only three toes.",
      visibility: "Easiest to see in the close-up.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor:
        "A white stripe down the middle of the black back on a Downy or Hairy Woodpecker. A Ladder-backed or Nuttall's Woodpecker has a back barred black and white, like the rungs of a ladder, and so does a Red-bellied; a Red-headed Woodpecker's back is solid black.",
      visibility: "Only its edge shows from the side; seen from behind or in flight from above.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers along each side of the back, black on a Downy.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor:
        "Black on a Downy. A Northern Flicker's white rump is easy to see in flight, a Red-headed Woodpecker's rump is white, and a Ladder-backed's is speckled with black.",
      visibility: "Covered by the wings on a clinging bird; seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The rows of smaller feathers covering the wing, shown here as one area. Black with white spots on a Downy. A Yellow-bellied Sapsucker has a white panel on its coverts, and a Great Spotted Woodpecker a large white shoulder patch.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor: "The small feathers at the front of the wing, black on a Downy.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor: "The middle row of coverts. On a Downy they carry some of the wing's white spots.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The longest row of coverts, just above the secondaries; spotted with white on a Downy.",
    },
    {
      id: "primary-coverts",
      name: "Primary coverts",
      group: "Wing",
      lookFor: "Coverts lying over the bases of the primaries, on the hand.",
      visibility: "Hidden on a clinging bird; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Hidden on a clinging bird; seen in flight.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the inner wing. On a Downy they are black with white spots that line up into bars across the wing. A Red-headed Woodpecker's are white, a big white patch on a black wing.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "The innermost flight feathers, lying over the rear of the folded wing; black with white spots on a Downy.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the hand, black with white spots on a Downy. A Northern Flicker's have yellow shafts in the East and red in the West. A Red-bellied Woodpecker shows white patches on the wings in flight, and a Pileated Woodpecker white wing feathers. Most woodpeckers fly in bounds: a few quick flaps, then a swooping glide.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor:
        "The feathers lining the underside of the wing. A Northern Flicker's underwings are yellow in the East and red in the West; a Yellow-bellied Sapsucker's are barred grey and white.",
      visibility: "Seen in flight.",
    },
    {
      id: "axillaries",
      name: "Axillaries",
      aka: "wingpits",
      group: "Wing",
      lookFor: "Feathers in the 'armpit', where the underwing meets the body.",
      visibility: "Seen in flight.",
    },
    // Underparts
    {
      id: "breast",
      name: "Breast",
      group: "Underparts",
      lookFor:
        "White on a Downy. A Northern Flicker has a black patch like a necklace across the upper breast, with black spots below it.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor:
        "White on a Downy. A Ladder-backed Woodpecker's cream flanks are speckled with black, and a Yellow-bellied Sapsucker has black arrowhead-shaped marks down its sides.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor:
        "White on a Downy. The reddish tinge that names the Red-bellied Woodpecker is hard to see in the field, and a Yellow-bellied Sapsucker's underparts are tinged yellow.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the base of the tail. A Great Spotted Woodpecker's lower belly and undertail are scarlet.",
    },
    // Tail
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Stiff: when a woodpecker clings to a trunk, its tail and feet work together to hold it up. Black in the middle on a Downy.",
    },
    {
      id: "outer-tail-feathers",
      name: "Outer tail feathers",
      group: "Tail",
      lookFor:
        "White with black bars or spots on a Downy, clean white on most Hairy Woodpeckers, though the darkest Hairies may show a few spots. A useful check when the bill is hard to judge.",
    },
  ],
};
