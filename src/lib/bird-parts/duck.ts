import type { DiagramText } from "./types";

export const duck: DiagramText = {
  id: "duck",
  title: "Duck",
  model: { species: "Mallard", age: "adult male", pose: "swimming" },
  intro:
    "Drawn from a drake (adult male) Mallard in breeding plumage, swimming. On a swimming duck, much of the wing is tucked away; head pattern, bill and the colours along the sides are usually the first marks.",
  sources: [
    {
      label: "Stockente, male, (Anas platyrhynchos), Vienna, Volksgarten-6168.jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Stockente,_male,_(Anas_platyrhynchos),_Vienna,_Volksgarten-6168.jpg",
      credit: "Hubertl, CC BY-SA 4.0",
    },
    { label: "Mallard (Wikipedia)", url: "https://en.wikipedia.org/wiki/Mallard" },
    { label: "Speculum feathers (Wikipedia)", url: "https://en.wikipedia.org/wiki/Speculum_feathers" },
    { label: "Greater scaup (Wikipedia)", url: "https://en.wikipedia.org/wiki/Greater_scaup" },
    { label: "Covert feather (Wikipedia)", url: "https://en.wikipedia.org/wiki/Covert_feather" },
    { label: "Glossary of bird terms: axillaries, underwing (Wikipedia)", url: "https://en.wikipedia.org/wiki/Glossary_of_bird_terms" },
    { label: "Northern shoveler (Wikipedia)", url: "https://en.wikipedia.org/wiki/Northern_shoveler" },
    { label: "American black duck (Wikipedia)", url: "https://en.wikipedia.org/wiki/American_black_duck" },
  ],
  parts: [
    // Head
    {
      id: "forehead",
      name: "Forehead",
      group: "Head",
      lookFor: "Where the head meets the bill. The angle here, steep or sloping into the bill, shapes the head's profile.",
    },
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor: "The top of the head. Note a crest, a peak, or a crown coloured differently from the face.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "The back of the head. Head shape helps with diving ducks: a Lesser Scaup's head often peaks at the back; a Greater Scaup's is usually rounder. Shape changes with posture, so use it with other marks.",
    },
    {
      id: "cheek",
      name: "Cheek",
      aka: "ear coverts, auriculars",
      group: "Head",
      lookFor:
        "The side of the head around and behind the eye, the area field guides call the ear coverts. Head colour and any patches or stripes here are the first marks for most ducks.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor: "Between the eye and the base of the bill. Glossy green on a drake Mallard, like the rest of the head.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor: "The band above the eye, from the bill back over the eye. Plain green on a drake Mallard, with no pale stripe.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor: "The band running back from the eye. Plain green on a drake Mallard.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor: "The thin ring of feathers around the eye. Green on a drake Mallard, with no ring of another colour.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "orbital-ring",
      name: "Orbital ring",
      aka: "bare eye-ring",
      group: "Head",
      lookFor: "The bare skin right around the eye, inside the feathered eye-ring. A drake Mallard shows none: the green feathers reach the eye.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor: "From the base of the lower bill back along the side of the throat. Plain green on a drake Mallard, with no stripe.",
    },
    {
      id: "chin",
      name: "Chin and throat",
      group: "Head",
      lookFor: "Below the bill. On most ducks it matches the head; a contrasting pale chin or throat is worth noting.",
    },
    {
      id: "neck",
      name: "Neck",
      group: "Head",
      lookFor: "On a drake Mallard, a thin white ring separates the green head from the chestnut breast.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Note its shape (broad, narrow, spoon-like) and colour. A drake Mallard's is yellow; a female's is orange and black.",
    },
    {
      id: "cere",
      name: "Cere",
      group: "Bill & legs",
      lookFor: "A soft, often coloured patch of skin at the base of the upper bill, where it meets the forehead, on some birds. A drake Mallard has none, so this area only marks where a cere would sit, on its plain yellow bill.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "nail",
      name: "Nail",
      group: "Bill & legs",
      lookFor: "A hard tip at the end of the bill. Its size can help: Greater Scaup's black nail averages broader than Lesser Scaup's, a supporting mark alongside head shape.",
    },
    {
      id: "legs",
      name: "Legs and feet",
      aka: "tarsus and toes",
      group: "Bill & legs",
      lookFor:
        "Orange on a Mallard. In flight a duck tucks its feet back under the tail.",
      visibility: "Under water on a swimming duck.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "The upper body between the neck and the rump; on a swimming duck much of it is covered by the folded wings.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers lying over the top of the folded wing. Their colour and fine patterning vary between species.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "Just in front of the tail. Black on a drake Mallard, as on many drakes.",
    },
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Tail",
      lookFor: "The feathers covering the base of the tail from above, just behind the rump. Black on a drake Mallard, like the rump.",
      visibility: "Seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      aka: "forewing",
      group: "Wing",
      lookFor:
        "The coverts of the forewing, in front of the white bar and the speculum. Gray-brown on a Mallard. On some dabbling ducks a coloured forewing is a key mark in flight, such as the pale blue forewing of a Northern Shoveler or Blue-winged Teal.",
      visibility: "Mostly covered by the side feathers on a swimming duck; seen in flight.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor:
        "The small coverts along the front edge of the wing; part of the forewing colour.",
      visibility: "Covered on a swimming duck; seen in flight.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor:
        "The row between the lesser and greater coverts; on a Mallard the same gray-brown as the rest of the forewing.",
      visibility: "Covered on a swimming duck; seen in flight.",
    },
    {
      id: "primary-coverts",
      name: "Primary coverts",
      group: "Wing",
      lookFor:
        "Coverts lying over the bases of the primaries, on the outer wing. Plain gray-brown on a Mallard.",
      visibility: "Covered on a swimming duck; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor:
        "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Covered on a swimming duck; seen in flight.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "Long inner feathers lying over the rear of the folded wing, above the speculum.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The outer flight feathers. At rest they're mostly tucked under the tertials and show only as the wingtip; in flight they form the outer wing, plain gray-brown on a Mallard.",
    },
    {
      id: "speculum",
      name: "Speculum",
      group: "Wing",
      lookFor:
        "A glossy patch on the secondaries. Its colour and borders help with dabbling ducks: a Mallard's is purple-blue with white edges on both sides.",
      visibility: "Often partly hidden on a swimming duck; clearest when it preens, stretches or flies.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the inner wing. Seen from above, their glossy outer parts make a Mallard's speculum; from below they're plain gray.",
      visibility: "Mostly hidden on a swimming duck; seen in flight.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The row of coverts just in front of the speculum. On a Mallard their white tips make the white bar on the speculum's front edge.",
      visibility: "Often partly hidden on a swimming duck.",
    },
    {
      id: "wing-bars",
      name: "Wing bars",
      aka: "wingbar",
      group: "Wing",
      lookFor: "Pale bars across the wing, formed by pale feather tips. A Mallard's speculum has a white bar on each side: the greater coverts' tips in front and the secondaries' tips behind. On the swimming duck only the rear bar is its own area; Flight, above, shows both.",
      visibility: "Often partly hidden on a swimming duck; clearest in flight.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor:
        "Small feathers covering the underside of the wing in front of the flight feathers. White on a Mallard. Pale wing linings against a dark body help pick out some ducks overhead, such as American Black Duck.",
      visibility: "Seen in flight, or when a bird raises its wings.",
    },
    {
      id: "axillaries",
      name: "Axillaries",
      aka: "wingpits",
      group: "Wing",
      lookFor:
        "Feathers in the 'armpit', where the underwing meets the body. White on a Mallard, like the wing linings.",
      visibility: "Seen in flight, or when a bird raises its wings.",
    },
    // Underparts
    {
      id: "breast",
      name: "Breast",
      group: "Underparts",
      lookFor: "The front of the body, at and above the waterline. Chestnut on a drake Mallard.",
    },
    {
      id: "sides",
      name: "Sides",
      group: "Underparts",
      lookFor:
        "The broad area below the folded wing, often the largest part of a swimming duck. Note its colour and any bar or stripe, such as the vertical white bar at the front of a drake Green-winged Teal's sides.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor:
        "Between the breast and the tail, underneath. Pale gray on a drake Mallard.",
      visibility: "Below the waterline on a swimming duck; seen in flight.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor: "The rear of the sides, in front of the tail. Some drakes have a contrasting patch here, such as the American Wigeon's white flank patch.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "Under the base of the tail. Black on a drake Mallard; easy to see as a duck swims away.",
    },
    // Tail
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor: "Note its length and how it's held: Ruddy Ducks often cock a stiff tail; drake pintails have long central tail feathers.",
      visibility:
        "A Mallard's tail is short; it's drawn longer on the swimming duck so it's easy to find.",
    },
    {
      id: "drake-curl",
      name: "Curled tail feathers",
      aka: "drake feathers",
      group: "Tail",
      lookFor: "A drake Mallard's black central tail feathers curl up and forward over the tail. Females don't have them.",
      visibility: "Usually lost or much straighter in summer, when drakes molt into their duller eclipse plumage.",
    },
  ],
};
