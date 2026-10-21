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
    { label: "Glossary of bird terms: axillaries, underwing (Wikipedia)", url: "https://en.wikipedia.org/wiki/Glossary_of_bird_terms" },
    { label: "Grey plover (Black-bellied Plover; Wikipedia)", url: "https://en.wikipedia.org/wiki/Grey_plover" },
    { label: "Short-billed dowitcher (Wikipedia)", url: "https://en.wikipedia.org/wiki/Short-billed_dowitcher" },
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
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor:
        "Behind the eye, between the supercilium and the ear coverts. Plain grey-brown on this Lesser Yellowlegs, whose dark line is in front of the eye, on the lores.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor:
        "From the base of the lower bill back along the side of the throat. Plain on this Lesser Yellowlegs, finely streaked like the rest of its face.",
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
      aka: "tarsus and toes",
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
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor:
        "The lower back, between the back and the uppertail coverts. Dark like the back on a Lesser Yellowlegs; its white patch starts behind the rump, on the uppertail coverts.",
      visibility: "Covered by the folded wings at rest; seen in flight.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The rows of feathers lying over the bases of the flight feathers: the lesser, median and greater coverts, and, on the outer wing, the primary coverts.",
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
      id: "primary-coverts",
      name: "Primary coverts",
      group: "Wing",
      lookFor:
        "Coverts lying over the bases of the primaries, on the outer wing. Usually dark on shorebirds.",
      visibility: "Mostly hidden on a standing bird; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor:
        "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Hidden at rest; seen in flight.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "The innermost flight feathers, lying on top of the folded wing. Their tips are the starting point for judging primary projection.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the inner wing, behind the greater coverts. Many sandpipers show a white wing stripe in flight, made mostly by pale tips to the greater coverts and pale bases to the flight feathers. Yellowlegs have plain dark wings without one.",
      visibility: "Mostly hidden under the tertials and coverts at rest; seen in flight.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The long outer flight feathers. On a standing bird their tips form the wingtip; in flight they make up most of the outer wing.",
    },
    {
      id: "primary-projection",
      name: "Primary projection",
      group: "Wing",
      lookFor:
        "How far the primaries extend beyond the tertials on the folded wing. It's usually judged against the exposed length of the tertials themselves, e.g. about half their length.",
    },
    {
      id: "wingtip-vs-tail",
      name: "Wingtip vs. tail",
      group: "Wing",
      lookFor:
        "Whether the folded wingtips fall short of the tail tip, reach it, or pass it. Baird's and White-rumped Sandpipers have wingtips well past the tail; a Least Sandpiper's don't reach beyond it.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor:
        "Small feathers covering the underside of the wing in front of the flight feathers. Whether they're pale or dark, plain or barred helps when a shorebird flies overhead.",
      visibility: "Seen in flight, or when a bird raises its wings.",
    },
    {
      id: "axillaries",
      name: "Axillaries",
      aka: "wingpits",
      group: "Wing",
      lookFor:
        "Feathers in the 'armpit', where the underwing meets the body. A Black-bellied Plover's black wingpits separate it from the golden-plovers in every plumage.",
      visibility: "Seen in flight, or when a bird raises its wings.",
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
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Tail",
      lookFor:
        "The feathers covering the base of the tail from above. A flying yellowlegs shows a square white patch here (field guides often call it a white rump); a dowitcher's white runs up the back in a narrow wedge.",
      visibility: "Mostly covered by the folded wings at rest; seen in flight.",
    },
  ],
};
