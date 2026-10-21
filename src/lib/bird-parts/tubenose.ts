import type { DiagramText } from "./types";

export const tubenose: DiagramText = {
  id: "tubenose",
  title: "Tubenose",
  model: { species: "Sooty Shearwater", age: "adult", pose: "swimming" },
  intro:
    "Drawn from an adult Sooty Shearwater on the water, with a close-up of its bill. Tubenoses (albatrosses, shearwaters, petrels, fulmars and storm-petrels) are named for the tubes on the bill that carry their nostrils. A Sooty Shearwater is dark chocolate-brown, looking all black in poor light, with a silvery stripe along the underwing. Look at the bill, the head pattern, the underwing, the rump, and the shape of the wings and tail.",
  sources: [
    {
      label: "Sooty shearwater kaikoura.jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Sooty_shearwater_kaikoura.jpg",
      credit: "Sabine's Sunbird, CC BY-SA 3.0",
    },
    {
      label: "Puffinus griseus -near Avila Beach, California, USA -upper body-8a.jpg (reference photo for the bill close-up, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Puffinus_griseus_-near_Avila_Beach,_California,_USA_-upper_body-8a.jpg",
      credit: "marlin harms, CC BY 2.0",
    },
    {
      label: "Puffinus griseus in flight - SE Tasmania (cropped).jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Puffinus_griseus_in_flight_-_SE_Tasmania_(cropped).jpg",
      credit: "JJ Harrison, CC BY-SA 3.0",
    },
    { label: "Sooty shearwater (Wikipedia)", url: "https://en.wikipedia.org/wiki/Sooty_shearwater" },
    { label: "Procellariiformes (Wikipedia)", url: "https://en.wikipedia.org/wiki/Procellariiformes" },
    { label: "Albatross (Wikipedia)", url: "https://en.wikipedia.org/wiki/Albatross" },
    { label: "Northern fulmar (Wikipedia)", url: "https://en.wikipedia.org/wiki/Northern_fulmar" },
    { label: "Sooty Shearwater (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/sooty-shearwater" },
    { label: "Short-tailed Shearwater (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/short-tailed-shearwater" },
    { label: "Pink-footed Shearwater (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/pink-footed-shearwater" },
    { label: "Great Shearwater (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/great-shearwater" },
    { label: "Manx Shearwater (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/manx-shearwater" },
    { label: "Northern Fulmar (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/northern-fulmar" },
    { label: "Black-footed Albatross (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/black-footed-albatross" },
    { label: "Wilson's Storm-Petrel (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/wilsons-storm-petrel" },
    { label: "Leach's Storm-Petrel (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/leachs-storm-petrel" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor:
        "Dark brown on a Sooty Shearwater, with a forehead that tapers into the bill. A Short-tailed Shearwater tends to have a rounder head and a steeper forehead. A Great Shearwater has a sharp black cap.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "Dark on a Sooty Shearwater. A Great Shearwater usually shows a narrow whitish band across the nape, below its black cap.",
    },
    {
      id: "face",
      name: "Face",
      group: "Head",
      lookFor: "The cheek below the eye, between the lores, the ear coverts and the malar. Dark on a Sooty Shearwater, like the whole head.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor: "The band above the eye, from the base of the bill back past the eye. A Sooty Shearwater has no pale eyebrow: it is dark like the crown.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor: "Between the eye and the base of the bill, dark on a Sooty Shearwater.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor: "The thin ring of feathers around the eye, dark on a Sooty Shearwater, so the dark eye barely shows.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor: "The band running back from the eye. A Sooty Shearwater shows no stripe here; its head is plain dark.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor:
        "Behind and below the eye, dark on a Sooty Shearwater. On a Manx Shearwater the face is dark and the white of the throat notches up behind the dark ear patch.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor: "The side of the throat, back from the base of the lower bill. Dark on a Sooty Shearwater, with no stripe.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor: "Dark brown on a Sooty Shearwater. The pale-bellied Pink-footed, Great and Manx Shearwaters are whitish or white below.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Thin and black on a Sooty Shearwater; a Short-tailed Shearwater's tends to be shorter. A tubenose's bill is made of seven to nine horny plates. Its shape and colour help: a Northern Fulmar's is very thick and yellow, a Pink-footed Shearwater's has a pink base, and a Black-footed Albatross has a heavy bill with white around its base.",
    },
    {
      id: "nostril-tubes",
      name: "Nostril tubes",
      aka: "naricorns",
      group: "Bill & legs",
      lookFor:
        "The tubes on top of the bill that carry the nostrils and give tubenoses their name. Tubenoses use smell to find food, where most birds rely on sight, and a salt gland above the nasal passage lets out salty water through the nostrils. An albatross has one tube along each side of its bill instead of on top.",
      visibility: "Easiest to see in the close-up.",
    },
    {
      id: "unguis",
      name: "Hooked tip",
      aka: "maxillary unguis",
      group: "Bill & legs",
      lookFor: "The hook at the tip of the upper bill is a plate of its own, one of the horny plates the bill is made of.",
      visibility: "Easiest to see in the close-up.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "Dark brown on a Sooty Shearwater. A Great Shearwater's back is dark grey-brown; a Manx Shearwater is blackish above.",
      visibility: "Covered by the folded wings on a swimming bird; seen in flight from above.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers lying over the base of each wing, dark like the back.",
    },
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Upperparts",
      lookFor: "The feathers lying over the base of the tail, dark on a Sooty Shearwater like the rump.",
      visibility: "Covered by the wings on a swimming bird; seen in flight from above.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor:
        "Dark on a Sooty Shearwater. A pale rump is a key mark on others: a Great Shearwater has a narrow whitish band across it, a Wilson's Storm-Petrel an obvious white patch, and Leach's is the only white-rumped storm-petrel usually seen off the Pacific Coast, though some there have dark rumps.",
      visibility: "Covered by the wings on a swimming bird; seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor: "The rows of smaller feathers covering the wing, shown here as one area. Dark brown on a Sooty Shearwater.",
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
      visibility: "Hidden on a swimming bird; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Hidden on a swimming bird; seen in flight.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor: "The flight feathers of the inner wing.",
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
        "The flight feathers of the hand, at the tip of a long, narrow wing. Shearwaters have a 'shearing' flight, dipping from side to side on stiff wings with few wingbeats, the wingtips almost touching the water. On this swimming bird the long wingtips cross above the tail.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor:
        "On a Sooty Shearwater they form the silvery stripe along the centre of the underwing, which shows in good light. A Short-tailed Shearwater's underwing is often plain medium to pale grey without the white flash, and the smaller Balearic Shearwater of the Atlantic lacks the pale stripe. A Manx Shearwater has white wing linings.",
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
      lookFor: "Dark brown on a Sooty Shearwater, like the rest of the body. A Great Shearwater is white below.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor: "The side of the body below the folded wing, dark brown on a Sooty Shearwater.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "Dark brown on a Sooty Shearwater. A Great Shearwater has a blurry dark patch on its white belly.",
      visibility: "Under the water on a swimming bird; seen in flight from below.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the base of the tail.",
      visibility: "Under the water on a swimming bird; seen in flight from below.",
    },
    // Tail
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Short on a shearwater. Tail shape helps with storm-petrels: a Leach's has a forked tail, a Wilson's a short, square one, and a Wilson's feet may reach past its tail in level flight.",
    },
  ],
};
