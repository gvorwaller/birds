import type { DiagramText } from "./types";

export const gamebird: DiagramText = {
  id: "gamebird",
  title: "Gamebird",
  model: { species: "Ruffed Grouse", age: "adult male", pose: "standing" },
  intro:
    "Drawn from a Ruffed Grouse with its crest raised and its tail spread. Gamebirds (grouse, ptarmigan, quail, partridges, pheasants and turkeys) live mainly on the ground, and many would rather run than fly; their wings are short and rounded, for short flights. A Ruffed Grouse comes in two colour morphs, grey and brown, and this one is a brown bird with a reddish tail. Look at the head (crest, comb and ruff), the shape and bands of the tail, the legs and feet, and the bars on the sides.",
  sources: [
    {
      label: "Ruffed Grouse (27299328967).jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Ruffed_Grouse_(27299328967).jpg",
      credit: "Darrin Franco, U.S. Fish and Wildlife Service, public domain",
    },
    {
      label: "Lagopus muta japonica female in flight.JPG (reference photo for the wing shape in flight, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Lagopus_muta_japonica_female_in_flight.JPG",
      credit: "Alpsdake, CC BY-SA 3.0",
    },
    { label: "Ruffed grouse (Wikipedia)", url: "https://en.wikipedia.org/wiki/Ruffed_grouse" },
    { label: "Grouse (Wikipedia)", url: "https://en.wikipedia.org/wiki/Grouse" },
    { label: "Galliformes (Wikipedia)", url: "https://en.wikipedia.org/wiki/Galliformes" },
    { label: "Ruffed grouse (National Park Service)", url: "https://www.nps.gov/articles/000/ruffed-grouse.htm" },
    { label: "Ruffed Grouse (Oiseaux-Birds)", url: "https://www.oiseaux-birds.com/card-ruffed-grouse.html" },
    { label: "Ruffed Grouse (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/ruffed-grouse" },
    { label: "Spruce Grouse (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/spruce-grouse" },
    { label: "Sharp-tailed Grouse (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/sharp-tailed-grouse" },
    { label: "Greater Prairie-Chicken (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/greater-prairie-chicken" },
    { label: "Greater Sage-Grouse (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/greater-sage-grouse" },
    { label: "Willow Ptarmigan (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/willow-ptarmigan" },
    { label: "Rock Ptarmigan (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/rock-ptarmigan" },
    { label: "Ring-necked Pheasant (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/ring-necked-pheasant" },
    { label: "California Quail (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/california-quail" },
    { label: "Black grouse (Wikipedia)", url: "https://en.wikipedia.org/wiki/Black_grouse" },
    { label: "Western capercaillie (Wikipedia)", url: "https://en.wikipedia.org/wiki/Western_capercaillie" },
    { label: "Hazel grouse (Wikipedia)", url: "https://en.wikipedia.org/wiki/Hazel_grouse" },
    { label: "Wild turkey (Wikipedia)", url: "https://en.wikipedia.org/wiki/Wild_turkey" },
    { label: "Common pheasant (Wikipedia)", url: "https://en.wikipedia.org/wiki/Common_pheasant" },
    { label: "California quail (Wikipedia)", url: "https://en.wikipedia.org/wiki/California_quail" },
    { label: "Northern bobwhite (Wikipedia)", url: "https://en.wikipedia.org/wiki/Northern_bobwhite" },
    { label: "Grey partridge (Wikipedia)", url: "https://en.wikipedia.org/wiki/Grey_partridge" },
    { label: "Chukar partridge (Wikipedia)", url: "https://en.wikipedia.org/wiki/Chukar_partridge" },
  ],
  parts: [
    // Head
    {
      id: "crest",
      name: "Crest",
      aka: "topknot",
      group: "Head",
      lookFor:
        "A Ruffed Grouse has a short crest, which sometimes lies flat. A male Hazel Grouse has a short crest it can raise, and the female's is shorter. Quail wear a plume or topknot: a California Quail's curves and is longer on the male, and a Gambel's Quail's is longer still.",
    },
    {
      id: "comb",
      name: "Comb",
      aka: "eye comb",
      group: "Head",
      lookFor:
        "A patch of bare skin above the eye. On a male Ruffed Grouse it is small and orange-red, more visible in spring, and the female lacks it. Male Spruce Grouse and Willow and Rock Ptarmigan raise red combs in display, and in Norway the Black Grouse and the Capercaillie show red bare skin above each eye.",
      visibility: "Small and easily missed on a Ruffed Grouse.",
    },
    {
      id: "face",
      name: "Face",
      group: "Head",
      lookFor:
        "The front of the head, seen from below in flight. Face patterns help with quail: a male California Quail has a black face outlined with white stripes.",
      visibility: "Drawn from below in flight. On the standing bird the face is named part by part: lores, supercilium, eye-line, ear coverts and malar.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor: "Between the eye and the base of the bill. Buffy brown on this grouse, like the rest of the face. A winter male Rock Ptarmigan has a black line from the eye to the bill.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor:
        "The feathered strip above the eye, around and behind the bare comb. Buffy brown on this grouse, with no pale stripe. A male Northern Bobwhite has a white stripe over the eye, bordered with black.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor:
        "The band from the eye back toward the nape. Plain on this Ruffed Grouse. A Chukar has a black band from the forehead through the eye that runs down into a necklace around its white throat.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor: "The thin ring of feathers around the eye, partly covered here by the comb above it.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor: "The patch behind and below the eye, over the ear. Buffy brown on this grouse.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor: "From the base of the lower bill back along the side of the throat, above the paler throat. Plain on this grouse, with no stripe.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor:
        "Often paler than the rest of a Ruffed Grouse. A male Northern Bobwhite has a white throat. A male Spruce Grouse has a black throat and chest edged with white; a male Hazel Grouse has a black throat bordered with white, which the female lacks.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "Grey-brown on a grey Ruffed Grouse, browner on a brown one.",
    },
    {
      id: "ruff",
      name: "Ruff",
      group: "Head",
      lookFor:
        "The dark feathers on each side of the neck that give the Ruffed Grouse its name. They usually lie flat and are hard to see, except when a displaying male raises his crest and ruff. Some grouse also inflate patches of bare skin: a male Sharp-tailed Grouse inflates sacs on its neck, a Greater Prairie-Chicken raises feather tufts over yellow neck sacs, and a Greater Sage-Grouse inflates two yellow air sacs on its chest.",
      visibility: "Usually flat; raised in display.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Short. A Chukar's is bright coral-red. A Rock Ptarmigan is smaller than a Willow Ptarmigan, with a smaller bill, though the females are very hard to tell apart. A male Wild Turkey has a fleshy flap over the bill, the snood, which swells when he is excited.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "leg",
      group: "Bill & legs",
      lookFor:
        "Feathered on a Ruffed Grouse, which helps it weather the cold. A ptarmigan's legs are feathered all the way down, and in winter a Willow Ptarmigan's feet are feathered to the tips of the toes. Most grouse have no spurs, but some male gamebirds grow sharp spurs that point backward on the leg, and a male Wild Turkey has one behind each lower leg.",
    },
    {
      id: "toes",
      name: "Toes",
      group: "Bill & legs",
      lookFor:
        "Each fall a Ruffed Grouse grows a fringe along the sides of its toes, which widens its feet like snowshoes; it sheds the fringe in spring.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "Streaked and mottled in reddish-brown to grey, for camouflage.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers lying over the base of each wing, here with pale streaks.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor:
        "Spotted with white. Telling a male Ruffed Grouse from a female is hard even in the hand, but rump feathers with more than one white dot are a fairly good sign of a male, and a single dot of a female.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor: "The rows of smaller feathers covering the wing, shown here as one area.",
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
      visibility: "Hidden on a standing bird; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Hidden on a standing bird; seen in flight.",
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
        "The flight feathers of the hand, at the tip of a short, rounded wing. A Ruffed Grouse surprised on the ground may explode into flight with loud wingbeats. In spring a male 'drums': standing on a log or a stone, he beats his wings against the air, a low-pitched sound that starts slow, speeds up, and carries a quarter of a mile or more.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor: "The feathers lining the underside of the wing.",
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
        "Light with bars on a grey Ruffed Grouse, darker on a brown one. A male Greater Sage-Grouse has a white breast against a black bib and belly.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor:
        "Wide dark and white bars on the sides, below the wing, can be conspicuous on a Ruffed Grouse. A Spruce Grouse lacks these broad bars and has black-and-white bars on the belly instead. A Chukar has bold black and white bars on its flanks.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor:
        "A Grey Partridge has a white belly, usually with a large chestnut horseshoe on males and many females. A California Quail's belly looks scaly. A Greater Sage-Grouse has a black belly (a dark patch on the female).",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the base of the tail. A male Black Grouse is black with white undertail coverts.",
    },
    // Tail
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Tail",
      lookFor: "The feathers lying over the base of the tail, between the rump and the fan. Brown on this grouse, like the rump.",
    },
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Long and fan-shaped on a Ruffed Grouse, finely barred, and grey or reddish depending on the morph; this one is spread. Tail shape is a key mark: a Sharp-tailed Grouse's is pointed and shows white outer feathers in flight, a Spruce Grouse's is shorter and darker with a rusty tip in most places, a Greater Prairie-Chicken shows a short black tail in flight, and a Ring-necked Pheasant's is long and pointed. In Norway, the Black Grouse's outer tail feathers curl outward into a lyre, a winter Willow Ptarmigan is white with black tail feathers, and a flying Hazel Grouse shows a grey tail with a black tip.",
    },
    {
      id: "subterminal-band",
      name: "Subterminal band",
      group: "Tail",
      lookFor:
        "A broad black band near the tip of the tail, with a pale tip beyond it. Males tend to have an unbroken band, and females often have a broken one, though either can happen.",
    },
  ],
};
