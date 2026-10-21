import type { DiagramText } from "./types";

export const raptor: DiagramText = {
  id: "raptor",
  title: "Raptor",
  model: { species: "Red-tailed Hawk", age: "adult light-morph", pose: "perched" },
  intro:
    "Drawn from an adult Red-tailed Hawk, North America's most widespread hawk. Hawks are often seen far off or overhead, so shape and a few bold marks matter most: the belly band and patagial bar on a Red-tailed Hawk, the leg feathering, the tail pattern, and where the wingtips fall. Plumage varies a lot, and dark birds lack several of these marks.",
  sources: [
    {
      label: "Red-tailed-hawk-perched.jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Red-tailed-hawk-perched.jpg",
      credit: "Kate Perez, CC BY-SA 4.0",
    },
    {
      label: "Buteo jamaicensis 7.jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Buteo_jamaicensis_7.jpg",
      credit: "Bear golden retriever from auburn,ny, usa, CC BY 2.0",
    },
    { label: "Red-tailed hawk (Wikipedia)", url: "https://en.wikipedia.org/wiki/Red-tailed_hawk" },
    { label: "Red-tailed hawk identification (USGS Patuxent)", url: "https://www.mbr-pwrc.usgs.gov/id/htmid/h3370id.html" },
    { label: "Red-tailed Hawk raptor ID fact sheet (HawkWatch International)", url: "https://hawkwatch.org/raptor-id/raptor-id-fact-sheets/red-tailed-hawk/" },
    { label: "Red-tailed Hawk patagial marks (HawkWatch International)", url: "https://hawkwatch.org/red-tailed-hawk-patagial-marks/" },
    { label: "Rough-legged buzzard (Wikipedia)", url: "https://en.wikipedia.org/wiki/Rough-legged_buzzard" },
    { label: "Ferruginous hawk (Wikipedia)", url: "https://en.wikipedia.org/wiki/Ferruginous_hawk" },
    { label: "Swainson's hawk (Wikipedia)", url: "https://en.wikipedia.org/wiki/Swainson%27s_hawk" },
    { label: "Peregrine falcon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Peregrine_falcon" },
    { label: "American kestrel (Wikipedia)", url: "https://en.wikipedia.org/wiki/American_kestrel" },
    { label: "Falcon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Falcon" },
    { label: "Osprey (Wikipedia)", url: "https://en.wikipedia.org/wiki/Osprey" },
    { label: "Cooper's hawk (Wikipedia)", url: "https://en.wikipedia.org/wiki/Cooper%27s_hawk" },
    { label: "Beak: cere (Wikipedia)", url: "https://en.wikipedia.org/wiki/Beak" },
    { label: "Flight feather: emarginations (Wikipedia)", url: "https://en.wikipedia.org/wiki/Flight_feather" },
    { label: "Glossary of bird terms: axillaries, underwing (Wikipedia)", url: "https://en.wikipedia.org/wiki/Glossary_of_bird_terms" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor: "Dark brown on most Red-tailed Hawks. A pale head is a clue to some other raptors, such as an adult Ferruginous Hawk.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "The back of the head and neck; brown like the crown on this adult.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor:
        "Between the eye and the cere. Greyish on this Red-tailed Hawk, paler than the brown face.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor:
        "Above the eye. Brown like the crown on this Red-tailed Hawk, with no pale stripe.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor:
        "Behind the eye, between the supercilium and the cheek. Plain brown on this Red-tailed Hawk.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor:
        "The narrow ring around the eye; dark like the face on this Red-tailed Hawk.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "ear-coverts",
      name: "Cheek",
      aka: "ear coverts",
      group: "Head",
      lookFor: "Behind and below the eye. On falcons the face pattern here is one of the best marks.",
    },
    {
      id: "malar",
      name: "Malar stripe",
      aka: "moustache",
      group: "Head",
      lookFor:
        "A dark stripe running down from the base of the bill. Faint or missing on many Red-tailed Hawks, but key on falcons: a Peregrine Falcon has a bold black 'moustache', and an American Kestrel has two narrow black marks on each side of its face.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor:
        "Below the bill. A white throat above a dark chest 'bib' marks a light adult Swainson's Hawk; Red-tailed Hawks vary here.",
    },
    {
      id: "iris",
      name: "Iris",
      group: "Head",
      lookFor:
        "Eye colour often tells age. A young Red-tailed Hawk has yellowish eyes that darken to reddish-brown over 3 to 4 years. Cooper's Hawks go the other way: yellow when young, orange to red as adults.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "A hooked bill for tearing prey. Falcons have a 'tooth' on the edge of the upper mandible, which they use to kill prey; hawks and eagles kill with their talons.",
    },
    {
      id: "cere",
      name: "Cere",
      group: "Bill & legs",
      lookFor:
        "The patch of bare, often brightly coloured skin at the base of the upper mandible, which usually holds the nostrils. Raptors, owls and parrots have one. Yellow on an adult Red-tailed Hawk.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "lower leg",
      group: "Bill & legs",
      lookFor:
        "Bare and yellow on a Red-tailed Hawk. Feathered on a Rough-legged Hawk, and feathered right down to the toes on a Ferruginous Hawk and a Golden Eagle: a useful check on a perched bird.",
    },
    {
      id: "talons",
      name: "Feet and talons",
      group: "Bill & legs",
      lookFor:
        "Hawks and eagles kill with their talons. An Osprey can turn its outer toe backward to hold a fish with two toes in front and two behind; only Ospreys and owls among raptors can.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "Brown on this adult, between the scapulars.",
      visibility: "Covered by the folded wings on a perched hawk; seen in flight from above.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor:
        "Shoulder feathers over the top of the folded wing. On many light Red-tailed Hawks they are mottled with white, making a pale 'V' on the back, best seen from above.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "Between the back and the tail; brown on this adult.",
      visibility: "Covered by the wings on a perched hawk; seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The rows of smaller feathers covering the wing, shown here as one area. Showing every feather group splits them into lesser, median and greater coverts.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor: "The small feathers at the front of the wing. Brown on this adult.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor: "The middle row of coverts. Pale edges here and on the other coverts give many hawks a scaly look.",
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
      visibility: "Hidden on a perched hawk; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Hidden on a perched hawk; seen in flight.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the inner wing. A buteo's long secondaries make its broad wing; their dark tips form the dark trailing edge seen from below.",
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
        "The flight feathers of the hand. From below they are pale on an adult Red-tailed Hawk, with dark tips; a light Swainson's Hawk instead has dark flight feathers against pale wing linings.",
    },
    {
      id: "fingers",
      name: "Fingers",
      aka: "slotted primaries",
      group: "Wing",
      lookFor:
        "The outer primaries narrow toward their tips (emarginations), so they spread apart in flight like fingers. Long, spread fingers mark soaring hawks and eagles; falcons have pointed wingtips.",
      visibility: "Seen in flight.",
    },
    {
      id: "wingtip-vs-tail",
      name: "Wingtip vs. tail",
      group: "Wing",
      lookFor:
        "Where the folded wingtips fall against the tail on a perched hawk. A Red-tailed Hawk's fall short of the tail tip; a Rough-legged Hawk's reach it or pass it.",
    },
    {
      id: "patagial-bar",
      name: "Patagial bar",
      aka: "patagial mark",
      group: "Wing",
      lookFor:
        "A dark bar along the leading edge of the inner underwing, between the body and the wrist (the patagium is the skin in front of the arm). It marks a Red-tailed Hawk at any age; other North American buteos lack it. Dark birds don't show it, and on some pale birds it is so faint it seems to be missing, so its absence alone doesn't rule out a Red-tail.",
      visibility: "Seen in flight from below.",
    },
    {
      id: "carpal-patch",
      name: "Carpal patch",
      aka: "comma",
      group: "Wing",
      lookFor:
        "A dark mark at the wrist on the underwing. A small dark 'comma' on a Red-tailed Hawk; a large, square black patch on a light Rough-legged Hawk.",
      visibility: "Seen in flight from below.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor:
        "The feathers covering the underside of the wing in front of the flight feathers. Pale on a light Red-tailed Hawk, with the patagial bar along their front edge.",
      visibility: "Seen in flight, or when a bird raises its wings.",
    },
    {
      id: "axillaries",
      name: "Axillaries",
      aka: "wingpits",
      group: "Wing",
      lookFor: "Feathers in the 'armpit', where the underwing meets the body. Pale on this adult, like the wing linings.",
      visibility: "Seen in flight, or when a bird raises its wings.",
    },
    {
      id: "trailing-edge",
      name: "Dark trailing edge",
      group: "Wing",
      lookFor:
        "Dark tips to the flight feathers make a dark band along the back of an adult Red-tailed Hawk's underwing, with dark tips on the outer primaries too.",
      visibility: "Seen in flight from below.",
    },
    // Underparts
    {
      id: "breast",
      name: "Breast",
      group: "Underparts",
      lookFor: "White to buff and often unmarked on a light Red-tailed Hawk, above the belly band.",
    },
    {
      id: "belly-band",
      name: "Belly band",
      group: "Underparts",
      lookFor:
        "A band of dark streaks across the belly, below a paler breast. Most Red-tailed Hawks have one, from heavy to faint; dark birds are dark all over instead.",
    },
    {
      id: "belly",
      name: "Lower belly",
      group: "Underparts",
      lookFor: "Whitish below the belly band on this adult.",
    },
    {
      id: "leg-feathers",
      name: "Leg feathers",
      aka: "leggings",
      group: "Underparts",
      lookFor:
        "The feathers on the thighs. Pale on most light Red-tailed Hawks. A light Ferruginous Hawk has rusty leg feathers that make a dark 'V' under the body in flight.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "Pale on this adult.",
    },
    // Tail
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Brick red from above and paler, pinkish, from below on a typical adult Red-tailed Hawk like this one, though it varies: some western adults show several dark bands, and Harlan's Hawks, a northern form, often have mottled whitish or gray tails. A young bird's is brown with fine bands. On many raptors the tail pattern, with its number and width of bands, is one of the best marks.",
    },
    {
      id: "subterminal-band",
      name: "Subterminal band",
      group: "Tail",
      lookFor:
        "A dark band near the tip of the tail. Usually one narrow black band on an adult Red-tailed Hawk like this one. A Rough-legged Hawk often has a broad dark band, or several, on a white-based tail, but some Harlan's Red-tailed Hawks also have pale tails with dark bands, so check other marks too.",
    },
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Tail",
      lookFor: "The feathers covering the base of the tail from above.",
      visibility: "Covered by the wings on a perched hawk; seen in flight from above.",
    },
  ],
};
