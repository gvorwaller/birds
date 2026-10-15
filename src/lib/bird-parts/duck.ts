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
      group: "Head",
      lookFor: "The side of the head around and behind the eye. Head colour and any patches or stripes here are the first marks for most ducks.",
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
      id: "nail",
      name: "Nail",
      group: "Bill & legs",
      lookFor: "A hard tip at the end of the bill. Its size can help: Greater Scaup's black nail averages broader than Lesser Scaup's, a supporting mark alongside head shape.",
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
    // Wing
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
      lookFor: "The outer flight feathers. At rest they're mostly tucked under the tertials and show only as the wingtip.",
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
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The row of coverts just in front of the speculum. On a Mallard their white tips make the white bar on the speculum's front edge.",
      visibility: "Often partly hidden on a swimming duck.",
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
