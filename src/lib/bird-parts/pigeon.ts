import type { DiagramText } from "./types";

export const pigeon: DiagramText = {
  id: "pigeon",
  title: "Pigeon",
  model: { species: "Rock Pigeon", age: "adult, wild type", pose: "standing" },
  intro:
    "Drawn from an adult Rock Pigeon (Rock Dove) of the wild type, standing on a rock. It is 30 to 35 cm long: pale grey with a darker blue-grey head, neck and chest, a green-and-purple sheen on the neck, two black bars across the wing, a white lower back and a black band at the tip of the tail. Pigeons and doves have small heads on large, compact bodies, short legs, and short bills with a fleshy cere at the base. Feral pigeons come in many other colour forms. Look at the neck, the wing (bars or spots), the tail's shape and pattern, and the bare skin around the eye.",
  sources: [
    {
      label: "Rock dove (Columba livia).jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Rock_dove_(Columba_livia).jpg",
      credit: "Charles J. Sharp, CC BY-SA 4.0",
    },
    {
      label: "Columba livia in flight.jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Columba_livia_in_flight.jpg",
      credit: "Mikhail Nevsky, CC BY 4.0",
    },
    {
      label: "Columba livia -flight-4.jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Columba_livia_-flight-4.jpg",
      credit: "Dario Sanches, CC BY-SA 2.0",
    },
    { label: "Rock dove (Wikipedia)", url: "https://en.wikipedia.org/wiki/Rock_dove" },
    { label: "Rock pigeon (National Geographic)", url: "https://www.nationalgeographic.com/animals/birds/facts/rock-pigeon" },
    { label: "Columbidae (Wikipedia)", url: "https://en.wikipedia.org/wiki/Columbidae" },
    { label: "Stock dove (Wikipedia)", url: "https://en.wikipedia.org/wiki/Stock_dove" },
    { label: "Common wood pigeon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Common_wood_pigeon" },
    { label: "Mourning dove (Wikipedia)", url: "https://en.wikipedia.org/wiki/Mourning_dove" },
    { label: "Eurasian collared dove (Wikipedia)", url: "https://en.wikipedia.org/wiki/Eurasian_collared_dove" },
    { label: "White-winged dove (Wikipedia)", url: "https://en.wikipedia.org/wiki/White-winged_dove" },
    { label: "Common ground dove (Wikipedia)", url: "https://en.wikipedia.org/wiki/Common_ground_dove" },
    { label: "Band-tailed pigeon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Band-tailed_pigeon" },
    { label: "Spotted dove (Wikipedia)", url: "https://en.wikipedia.org/wiki/Spotted_dove" },
    { label: "Rock Pigeon (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/rock-pigeon" },
    { label: "Mourning Dove (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/mourning-dove" },
    { label: "Eurasian Collared-Dove (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/eurasian-collared-dove" },
    { label: "White-winged Dove (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/white-winged-dove" },
    { label: "Common Ground Dove (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/common-ground-dove" },
    { label: "Band-tailed Pigeon (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/band-tailed-pigeon" },
    { label: "Spotted Dove (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/spotted-dove" },
  ],
  parts: [
    // Head
    {
      id: "forehead",
      name: "Forehead",
      group: "Head",
      lookFor: "Dark blue-grey on a Rock Pigeon, like the rest of the head, running down to the cere at the base of the bill.",
      visibility: "Small on the bird: larger in the head close-up, or pick it from the list.",
    },
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor:
        "Dark blue-grey on a Rock Pigeon. An adult male Mourning Dove has a blue-grey crown, which the female lacks; a male Common Ground Dove has slate-grey feathers on top of the head.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor:
        "Dark blue-grey on a Rock Pigeon. Several doves carry their mark here: a Eurasian Collared-Dove has a black half-collar edged with white on the nape, a Spotted Dove a black half-collar spotted with white, and a Band-tailed Pigeon a narrow white band across the nape, with green sheen on the neck just behind it.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor:
        "Between the eye and the base of the bill. Dark blue-grey on a Rock Pigeon. On a Common Ground Dove the feathers around the base of the bill are pink.",
      visibility: "Small on the bird: larger in the head close-up, or pick it from the list.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor: "The band above the eye. Plain dark blue-grey on a Rock Pigeon, with no pale stripe.",
      visibility: "Small on the bird: larger in the head close-up, or pick it from the list.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor: "The band through the eye. Plain on a Rock Pigeon, like the rest of the dark head.",
      visibility: "Small on the bird: larger in the head close-up, or pick it from the list.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor:
        "The ring of feathers around the eye. Dark blue-grey on a Rock Pigeon, like the head; the pale ring right around the eye is bare skin (the orbital ring).",
      visibility: "Small on the bird: larger in the head close-up, or pick it from the list.",
    },
    {
      id: "orbital-ring",
      name: "Orbital ring",
      aka: "bare eye-ring",
      group: "Head",
      lookFor:
        "The bare skin right around the eye. On a wild Rock Pigeon the eyelids are grey, with a very narrow bluish-grey to grey-white ring, wider on domestic and feral birds. Its colour helps with doves: light blue on a Mourning Dove, blue on a White-winged Dove, and white or yellow on a Eurasian Collared-Dove. Look at the iris too: red-brown to orange-red on a Rock Pigeon, pale yellow on a Common Wood Pigeon, and dark on a Stock Dove.",
      visibility: "Small on the bird: larger in the head close-up, or pick it from the list.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor:
        "The patch behind and below the eye. Plain dark blue-grey on a Rock Pigeon. A Mourning Dove has a crescent of dark feathers below the eye, and a male White-winged Dove a more distinct ear spot than the female.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor:
        "From the base of the lower bill back along the side of the throat. Plain on a Rock Pigeon; an adult White-winged Dove has a long, dark mark on the lower face.",
      visibility: "Small on the bird: larger in the head close-up, or pick it from the list.",
    },
    {
      id: "chin",
      name: "Chin",
      group: "Head",
      lookFor: "Dark blue-grey on a Rock Pigeon, like the throat.",
      visibility: "Small on the bird: larger in the head close-up, or pick it from the list.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor: "Dark blue-grey on a Rock Pigeon, like the head.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Short, as on all pigeons and doves; grey-black on a Rock Pigeon, about 1.8 cm long. A Eurasian Collared-Dove's bill is black, a Band-tailed Pigeon's yellow, and a Stock Dove's pink with a yellow tip.",
    },
    {
      id: "cere",
      name: "Cere",
      group: "Bill & legs",
      lookFor:
        "The fleshy saddle over the base of the upper bill, a feature of pigeons and doves. Small and off-white on a wild Rock Pigeon; domestic and feral birds have a much larger one.",
      visibility: "Small on the bird: larger in the head close-up, or pick it from the list.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "leg",
      group: "Bill & legs",
      lookFor:
        "The short lower leg, 2.6 to 3.5 cm on a Rock Pigeon, whose feet are red to pink. A Mourning Dove's short legs are reddish, a Eurasian Collared-Dove's red, and a Band-tailed Pigeon's feet yellow.",
    },
    {
      id: "toes",
      name: "Toes",
      aka: "feet",
      group: "Bill & legs",
      lookFor:
        "Red to pink on a Rock Pigeon. A Mourning Dove's perching feet have three toes forward and one reversed.",
    },
    // Upperparts
    {
      id: "neck-patch",
      name: "Neck patch",
      aka: "iridescent neck",
      group: "Upperparts",
      lookFor:
        "The glossy sheen on the neck, green to reddish purple on a Rock Pigeon depending on the light; on a female it is less intense and kept more to the back and sides of the neck, and a juvenile, browner overall, lacks it. A male Mourning Dove has bright purple-pink patches on the sides of the neck, often faint on females. An adult Common Wood Pigeon has green and white patches on the neck (young birds lack the white), and a Stock Dove a green-to-purple patch on the side of the neck.",
    },
    {
      id: "back",
      name: "Back",
      aka: "mantle",
      group: "Upperparts",
      lookFor:
        "Mid-grey on a Rock Pigeon. A Mourning Dove is light grey-brown above, a White-winged Dove brownish grey, and a Common Ground Dove brown.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "The feathers over the base of the wing, along each side of the back. Grey on a Rock Pigeon, like the back.",
    },
    {
      id: "rump",
      name: "Rump",
      aka: "lower back",
      group: "Upperparts",
      lookFor:
        "White on a wild Rock Pigeon: its best identification mark. A Stock Dove, which also has a dark tail band and wing bars, has a grey rump. Some Rock Pigeon subspecies have a back the same grey as the mantle instead.",
      visibility: "Mostly hidden under the folded wings; easy to see from above in flight.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The rows of smaller feathers over the base of the wing, shown here as one area. Pale grey on a Rock Pigeon; the black tips of its greater coverts make the front one of its two wing bars. A Mourning Dove has black spots here, and a Common Ground Dove brown coverts spotted with black; a Spotted Dove has no black spots on the wing. A White-winged Dove shows a bold white wing patch, visible at rest and as a white crescent in flight, and a Common Wood Pigeon a white patch on the wing.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor: "The small feathers along the front and top of the folded wing.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor:
        "The middle row of coverts. On Spotted Doves of India and Sri Lanka they are brown, tipped with rufous spots.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The longest row of coverts, at the rear of the covert area, next to the flight feathers. On a Rock Pigeon their black tips make the front wing bar.",
    },
    {
      id: "wing-bars",
      name: "Wing bars",
      group: "Wing",
      lookFor:
        "Two bold black bars across the inner wing of a wild-type Rock Pigeon, distinctive on its pale grey wing: the black tips of the greater coverts, and behind them the black tips of the secondaries. A Stock Dove's two bars are short and incomplete, and a Mourning Dove has black spots rather than bars. Feral pigeons come in many other colour forms, so their wings may differ.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers at the bend of the wing, on the bird's 'thumb'.",
    },
    {
      id: "primary-coverts",
      name: "Primary coverts",
      group: "Wing",
      lookFor: "Coverts lying over the bases of the primaries.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor:
        "Feathers at the inner end of the wing, next to the body, that cover the folded flight feathers. A Stock Dove's short wing bars are on the tertials and greater coverts.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor: "The flight feathers of the inner wing. On a Rock Pigeon their black tips make the rear wing bar. A Stock Dove's grey wings show a dark trailing edge in flight.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the outer wing, making the long, pointed wingtip. A Common Ground Dove's chestnut primaries show only in flight. A Rock Pigeon often glides with its wings held up in a pronounced V.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor:
        "The feathers lining the underside of the wing. White on a Rock Pigeon, conspicuous as it circles overhead; a Stock Dove's underwing is dark grey, and a Eurasian Collared-Dove shows a blue-grey patch under the wing.",
      visibility: "Seen in flight.",
    },
    {
      id: "axillaries",
      name: "Axillaries",
      aka: "wingpits",
      group: "Wing",
      lookFor: "Feathers in the 'armpit', where the underwing meets the body: white on a Rock Pigeon, part of its white underwing.",
      visibility: "Seen in flight.",
    },
    // Underparts
    {
      id: "breast",
      name: "Breast",
      group: "Underparts",
      lookFor:
        "Dark blue-grey on a Rock Pigeon, with sheen below the neck; on a female the sheen on the breast is often very faint. A male Mourning Dove is pinkish on the chest, a Common Wood Pigeon pink, a Stock Dove lightly washed pinkish purple, and a Common Ground Dove scaly on the head and upper breast.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor:
        "Pale grey on a Rock Pigeon. A Band-tailed Pigeon's belly is nearly white, a Spotted Dove's white in the centre, and a male Common Ground Dove's pinkish grey.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor: "Pale grey on a Rock Pigeon, below the folded wing.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the base of the tail. Grey on a Rock Pigeon; a Spotted Dove's vent is white.",
    },
    // Tail
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Tail",
      lookFor: "The feathers lying over the base of the tail, between the white rump and the grey tail on a Rock Pigeon.",
    },
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Grey on a Rock Pigeon, the outer webs of its feathers edged with white, ending in a black band. Shape and pattern separate the doves: a Mourning Dove's tail is long and pointed, showing white spots along the edge in flight; a White-winged Dove's short and rounded, with white tips to the outer feathers; a Eurasian Collared-Dove's shows big white patches in the outer feathers; and a Spotted Dove's outer feathers are tipped white, seen as it takes off.",
    },
    {
      id: "tail-band",
      name: "Tail band",
      group: "Tail",
      lookFor:
        "The black band at the tip of a Rock Pigeon's tail. A Stock Dove has a broad dark grey band at the tip. A Band-tailed Pigeon is named for its tail: the outer half is pale, with a wide darker grey band at its base.",
    },
  ],
};
