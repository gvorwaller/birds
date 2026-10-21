import type { DiagramText } from "./types";

export const grebe: DiagramText = {
  id: "grebe",
  title: "Grebe",
  model: { species: "Horned Grebe", age: "adult, breeding", pose: "swimming" },
  intro:
    "Drawn from an adult Horned Grebe (the Slavonian Grebe in Europe) in breeding plumage on the water, with a close-up of a grebe's foot. Grebes are diving birds with their feet set far back on the body, and their toes have lobes instead of full webs. In breeding plumage a Horned Grebe has golden 'horns' on a black head, a chestnut neck and flanks, and a black back; in winter it is black and white. Look at the head pattern, the neck colour and the bill, and in winter at where the dark cap meets the white cheek.",
  sources: [
    {
      label: "Podiceps auritus (13909539717).jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Podiceps_auritus_(13909539717).jpg",
      credit: "Ekaterina Chernetsova (Papchinskaya), CC BY 2.0",
    },
    {
      label: "Foot of Great Crested Grebe (Anton Reichenow 1913).jpg (reference for the foot close-up, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Foot_of_Great_Crested_Grebe_(Anton_Reichenow_1913).jpg",
      credit: "Anton Reichenow, public domain",
    },
    {
      label: "NZ7 6117 (54792993882).jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:NZ7_6117_(54792993882).jpg",
      credit: "Bengt Nyman, CC0",
    },
    { label: "Horned grebe (Wikipedia)", url: "https://en.wikipedia.org/wiki/Horned_grebe" },
    { label: "Ohrentaucher (German Wikipedia)", url: "https://de.wikipedia.org/wiki/Ohrentaucher" },
    { label: "Grèbe esclavon (French Wikipedia)", url: "https://fr.wikipedia.org/wiki/Gr%C3%A8be_esclavon" },
    { label: "Grebe (Wikipedia)", url: "https://en.wikipedia.org/wiki/Grebe" },
    { label: "Black-necked grebe (Wikipedia)", url: "https://en.wikipedia.org/wiki/Black-necked_grebe" },
    { label: "Red-necked grebe (Wikipedia)", url: "https://en.wikipedia.org/wiki/Red-necked_grebe" },
    { label: "Pied-billed grebe (Wikipedia)", url: "https://en.wikipedia.org/wiki/Pied-billed_grebe" },
    { label: "Western grebe (Wikipedia)", url: "https://en.wikipedia.org/wiki/Western_grebe" },
    { label: "Great crested grebe (Wikipedia)", url: "https://en.wikipedia.org/wiki/Great_crested_grebe" },
    { label: "Little grebe (Wikipedia)", url: "https://en.wikipedia.org/wiki/Little_grebe" },
    { label: "Loon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Loon" },
    { label: "Horned Grebe (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/horned-grebe" },
    { label: "Eared Grebe (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/eared-grebe" },
    { label: "Pied-billed Grebe (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/pied-billed-grebe" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor:
        "Black, with a flat forehead. An Eared Grebe has a steeper forehead and a more peaked head. In winter a Horned Grebe's dark crown meets its white cheek in a straight line behind the eye.",
    },
    {
      id: "ear-tufts",
      name: "Ear tufts",
      aka: "horns",
      group: "Head",
      lookFor:
        "The golden 'horns' that give the Horned Grebe its name, tufts of feathers the bird can raise. They are a little fuller on males, and the winter plumage has none. An Eared Grebe (the Black-necked Grebe in Europe) has a fan of golden plumes spreading behind the eye over the side of its head instead, and a black neck.",
    },
    {
      id: "face",
      name: "Face",
      group: "Head",
      lookFor:
        "The lower face, below the cheek and in front of the throat: black on a breeding Horned Grebe. A breeding Red-necked Grebe has very pale grey cheeks and throat.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor: "The band above the eye. On a breeding Horned Grebe it is a black strip between the crown and the golden 'horns'. A Great Crested Grebe always shows white above the eye.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor: "The line through and just behind the eye. On a breeding Horned Grebe the golden 'horn' begins here, just behind the red eye, and widens back into the ear tufts.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor: "The thin ring of feathers around the red eye, dark on a breeding Horned Grebe.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor:
        "The cheek behind and below the eye, under the golden 'horns': black, fan-shaped feathers on a breeding Horned Grebe. In winter its cheeks are clean white; a winter Eared Grebe looks dingier, with darker cheeks.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor: "From the base of the lower bill back along the side of the throat. Black on a breeding Horned Grebe, with no stripe.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor: "Between the eye and the bill: chestnut on a breeding Horned Grebe. A breeding Eared Grebe has a blackish line from the bill to the eye.",
    },
    {
      id: "iris",
      name: "Iris",
      group: "Head",
      lookFor:
        "Red on an adult Horned Grebe, brightest in the breeding season. Eared and Western Grebes have red eyes too, but a Red-necked Grebe's eyes are dark brown.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "The back of the black head. On a winter Horned Grebe the white of the cheeks reaches almost to the back of the head.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor: "Under the black head on this bird. A breeding Pied-billed Grebe has a black throat too; a breeding Red-necked Grebe's throat is very pale grey.",
    },
    {
      id: "neck",
      name: "Neck",
      group: "Head",
      lookFor:
        "Chestnut on a breeding Horned Grebe, black on a breeding Eared Grebe and rusty red on a breeding Red-necked Grebe. In winter a Horned Grebe's neck is white, and an Eared Grebe's is greyer. A Western Grebe has a long, slender, swan-like neck.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Straight and pointed, with a whitish tip. An Eared Grebe's is thinner and slightly upturned. A Pied-billed Grebe's is short and thick, white with a black ring in the breeding season. A Red-necked Grebe's is black with a yellow base. A Western Grebe's is straight and greenish-yellow, a Clark's Grebe's upturned and bright yellow.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "lower leg",
      group: "Bill & legs",
      lookFor:
        "Grey on a Horned Grebe. A grebe's legs are set far back on its body, which makes it a strong swimmer but poor on land: a Little Grebe cannot walk well, and a Pied-billed Grebe cannot walk on land at all.",
      visibility: "Under the water on a swimming bird; shown in the close-up.",
    },
    {
      id: "toes",
      name: "Toes",
      group: "Bill & legs",
      lookFor:
        "Each toe has its own broad lobe; only small webs join the bases of the three front toes. A grebe swims by spreading its feet and bringing them inward, and the lobes work like oars, giving little resistance as the foot moves forward. A loon's toes are joined by webs. A Horned Grebe's feet are blue to blue-green.",
      visibility: "Under the water on a swimming bird; shown in the close-up. In flight the feet trail behind the body.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "Black on a breeding Horned Grebe, dull black-grey in winter. A juvenile's back is tinged with brown.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers lying over the folded wing, dark like the back.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "Dark. A grebe's tail is short, so on the water the rump ends the body. A winter Eared Grebe has a fluffier rump than a Horned Grebe.",
      visibility: "Seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor: "The rows of smaller feathers covering the wing, shown here as one area. Dark on a Horned Grebe, apart from a small white mark at the shoulder.",
      visibility: "Hidden on a swimming grebe; seen in flight.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor: "The small feathers at the front of the wing, where a Horned Grebe has its small white shoulder mark.",
      visibility: "Hidden on a swimming grebe; seen in flight.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor: "The middle row of coverts.",
      visibility: "Hidden on a swimming grebe; seen in flight.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The longest row of coverts, just above the secondaries.",
      visibility: "Hidden on a swimming grebe; seen in flight.",
    },
    {
      id: "primary-coverts",
      name: "Primary coverts",
      group: "Wing",
      lookFor: "Coverts lying over the bases of the primaries, on the hand.",
      visibility: "Hidden on a swimming grebe; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Hidden on a swimming grebe; seen in flight.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the inner wing. A Horned Grebe shows a white patch on the inner wing in flight. A Red-necked Grebe's wings are grey with white secondaries, while a Pied-billed Grebe shows no white under its wings in flight.",
      visibility: "Hidden on a swimming grebe; seen in flight.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "The innermost flight feathers, next to the body.",
      visibility: "Hidden on a swimming grebe; seen in flight from above.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the hand: brown on a Horned Grebe, with paler inner webs that are white at the base. Grebes are not strong or fast fliers, and a Horned Grebe must patter across the water to take off. It flies with its neck stretched out and its legs trailing.",
      visibility: "Hidden on a swimming grebe; seen in flight.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor: "White on a Horned Grebe. A Pied-billed Grebe has no white showing under its wings in flight.",
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
      lookFor: "Chestnut across the upper chest of a breeding Horned Grebe, white in winter.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor:
        "Chestnut on a breeding Horned Grebe; tawny-rufous to maroon-chestnut on a breeding Eared Grebe. A Clark's Grebe has whiter flanks than a Western Grebe.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor:
        "Dull white. A grebe's belly feathers are its densest, almost like fur. Grebes swallow their own feathers when preening and feed them to their young.",
      visibility: "Usually hidden under the water on a swimming bird; seen in flight from below.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the short tail, between the trailing feet in flight. A Pied-billed Grebe's undertail is white.",
      visibility: "Under the water on a swimming bird; seen in flight from below.",
    },
  ],
};
