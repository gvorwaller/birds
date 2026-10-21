import type { DiagramText } from "./types";

export const auk: DiagramText = {
  id: "auk",
  title: "Auk",
  model: { species: "Common Murre", age: "adult breeding", pose: "standing" },
  intro:
    "Drawn from an adult Common Murre in breeding plumage, called the Common Guillemot in Britain and Europe. Auks (the murres, the Razorbill, guillemots, puffins, auklets and murrelets) swim underwater with their wings and stand upright on land, like penguins, though the two groups are not closely related. Look at the shape and markings of the bill, the face pattern, how the dark neck meets the white breast, the wing pattern and the colour of the feet.",
  sources: [
    {
      label: "Common Guillemot - Farne Is - FJ0A4774 (36290042336).jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Common_Guillemot_-_Farne_Is_-_FJ0A4774_(36290042336).jpg",
      credit: "Francesco Veronesi, CC BY-SA 2.0",
    },
    {
      label: "Common murre - Oregon, 2026-5.jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Common_murre_-_Oregon,_2026-5.jpg",
      credit: "Casey Helton, CC BY-SA 4.0",
    },
    {
      label: "Common murre - Oregon, 2026.jpg (reference photo for the feet in flight, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Common_murre_-_Oregon,_2026.jpg",
      credit: "Casey Helton, CC BY-SA 4.0",
    },
    { label: "Common murre (Wikipedia)", url: "https://en.wikipedia.org/wiki/Common_murre" },
    { label: "Thick-billed murre (Wikipedia)", url: "https://en.wikipedia.org/wiki/Thick-billed_murre" },
    { label: "Auk (Wikipedia)", url: "https://en.wikipedia.org/wiki/Auk" },
    { label: "Razorbill (Wikipedia)", url: "https://en.wikipedia.org/wiki/Razorbill" },
    { label: "Atlantic puffin (Wikipedia)", url: "https://en.wikipedia.org/wiki/Atlantic_puffin" },
    { label: "Horned puffin (Wikipedia)", url: "https://en.wikipedia.org/wiki/Horned_puffin" },
    { label: "Tufted puffin (Wikipedia)", url: "https://en.wikipedia.org/wiki/Tufted_puffin" },
    { label: "Rhinoceros auklet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Rhinoceros_auklet" },
    { label: "Cassin's auklet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Cassin%27s_auklet" },
    { label: "Black guillemot (Wikipedia)", url: "https://en.wikipedia.org/wiki/Black_guillemot" },
    { label: "Pigeon guillemot (Wikipedia)", url: "https://en.wikipedia.org/wiki/Pigeon_guillemot" },
    { label: "Common Murre (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/common-murre" },
    { label: "Thick-billed Murre (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/thick-billed-murre" },
    { label: "Razorbill (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/razorbill" },
    { label: "Black Guillemot (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/black-guillemot" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor:
        "Dark on a breeding adult, like the rest of the head. Common Murres of the British and Irish subspecies, like this one, are dark brown rather than black.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "The back of the head and neck: dark, like the back.",
    },
    {
      id: "face",
      name: "Face",
      group: "Head",
      lookFor:
        "Dark in breeding plumage. After breeding the face turns white, with a dark spur running back from the eye. 'Bridled' Common Murres, found in the North Atlantic and commoner the farther north they breed, have a white ring around the eye extending back as a white line. A Thick-billed Murre is never bridled, and in winter it keeps less white on the face.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor:
        "The feathers just outside the eye. Dark on this murre, but a 'bridled' Common Murre has a white ring around the eye.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor:
        "The feathers between the eye and the bill. Dark on a breeding Common Murre.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor:
        "The area above the eye, from the bill back. Dark on a breeding Common Murre, with no pale stripe.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor:
        "A band through the eye, from the bill back to behind the eye. On a 'bridled' Common Murre the white eye-ring runs back from the eye as a white line here; after breeding, a dark spur runs back from the eye across the white face.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor:
        "The feathers behind and below the eye, over the ear. Dark in breeding plumage. After breeding the face turns white, with a dark spur running back from the eye.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor:
        "The area along the lower edge of the face, from the base of the lower bill back. Dark on a breeding Common Murre, with no stripe.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor:
        "Dark on a breeding adult, down to the top of the breast. On a Thick-billed Murre the white of the breast may come higher, in a point. Young birds in their first summer often keep some white feathers around the throat.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Thin, dark and pointed on a Common Murre. A Thick-billed Murre's is thicker and shorter, with a white stripe along the gape. A Razorbill's is deep, flattened from side to side and blunt, crossed near the tip by a white line, and a thin white line runs from the eye to the bill. Puffins grow bright plates on the bill for the breeding season and shed them afterwards; an Atlantic Puffin also has a yellow rosette where the two halves of the bill meet. A breeding Rhinoceros Auklet grows a horn on its bill, also shed every year.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "lower leg",
      group: "Bill & legs",
      lookFor: "Dark grey on a Common Murre, occasionally yellowish-grey. Auks stand upright on land and walk clumsily.",
    },
    {
      id: "toes",
      name: "Toes",
      group: "Bill & legs",
      lookFor:
        "Webbed. Auks swim underwater mainly with their wings; puffins and the Black Guillemot steer with their feet. On breeding adults the colour of the feet helps with other auks: red on Black and Pigeon Guillemots, orange on Atlantic and Horned Puffins and bright red on Tufted Puffins. On Black Guillemots and Horned and Tufted Puffins they fade after the breeding season, and a young Atlantic Puffin's feet are dark. Cassin's Auklet's feet are blue.",
      visibility: "In flight from below, the feet show beside the short tail. A Razorbill's feet do not reach past its tail in flight.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "Dark, like the wings: murres are dark above and white below. A Thick-billed Murre's back is blacker, though that is hard to see without both side by side.",
      visibility: "Covered by the folded wings on a standing murre; seen in flight from above.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers lying over the base of each wing, dark like the back.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "Between the back and the tail; dark.",
      visibility: "Covered by the wings on a standing murre; seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The rows of smaller feathers covering the wing, shown here as one area. Dark on a murre. A breeding Black Guillemot is black with a large white patch here; a Pigeon Guillemot's white patch is broken by a dark wedge.",
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
      visibility: "Hidden on a standing murre; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Hidden on a standing murre; seen in flight.",
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
        "The flight feathers of the hand. An auk's short wings are a compromise between diving and flying, so it beats them very fast. Common Murres cannot fly for 45 to 60 days while they moult their primaries.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor:
        "The feathers covering the underside of the wing in front of the flight feathers. A Pigeon Guillemot's underwing is plain and dark in every plumage; in the breeding season its dusky-grey underwing helps tell it from a Black Guillemot.",
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
      lookFor: "White below the dark neck. Look at the shape of the edge between them (see Throat).",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor: "Common Murres often have dark streaks here, beside the folded wing, as on this bird.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "White on an adult, like the rest of the underparts.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the base of the tail.",
    },
    // Tail
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Tail",
      lookFor:
        "The feathers lying over the base of the tail. Dark, like the rump.",
      visibility: "Seen in flight from above.",
    },
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Small and rounded on a Common Murre. A Razorbill's tail is longer and pointed, and often cocked up above the water when it swims.",
    },
  ],
};
