import type { DiagramText } from "./types";

export const songbird: DiagramText = {
  id: "songbird",
  title: "Songbird",
  model: { species: "Song Sparrow", age: "adult", pose: "perched" },
  intro:
    "A typical songbird, shaped after an adult Song Sparrow. Some marks, such as the two wing bars, are drawn to show where they appear on the many songbirds that have them.",
  sources: [
    {
      label: "Song sparrow in Prospect Park (93031).jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Song_sparrow_in_Prospect_Park_(93031).jpg",
      credit: "Rhododendrites, CC BY-SA 4.0",
    },
    { label: "Bird anatomy (Wikipedia)", url: "https://en.wikipedia.org/wiki/Bird_anatomy" },
    { label: "Covert feather (Wikipedia)", url: "https://en.wikipedia.org/wiki/Covert_feather" },
    { label: "Flight feather (Wikipedia)", url: "https://en.wikipedia.org/wiki/Flight_feather" },
    { label: "Alula (Wikipedia)", url: "https://en.wikipedia.org/wiki/Alula" },
    { label: "Lore (Wikipedia)", url: "https://en.wikipedia.org/wiki/Lore_(anatomy)" },
  ],
  parts: [
    // Head
    {
      id: "forehead",
      name: "Forehead",
      group: "Head",
      lookFor: "The front of the head, just above the bill. Check whether it matches the crown or contrasts with it.",
    },
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor:
        "The top of the head. Look for a plain cap or for stripes: many sparrows have a pale central crown stripe between two darker stripes.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "The back of the head where it meets the neck. A nape coloured differently from the crown and back is a useful mark.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor:
        "The small area between the eye and the bill. Whether it's dark, pale or coloured helps separate several look-alike species.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor:
        "A ring of feathers around the eye. Note whether it's complete, broken at the front and back, or missing, and whether it's bold or faint.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor:
        "A stripe above the eye. Note its colour and length, and whether it starts in front of the eye or only behind it.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor: "A stripe through the eye, usually dark. Whether it runs in front of the eye as well as behind it is a common field mark.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars, ear patch",
      group: "Head",
      lookFor:
        "The feathers that cover the ear, behind and below the eye. A darker or outlined patch here shapes the face pattern of many sparrows.",
    },
    {
      id: "submoustachial",
      name: "Submoustachial stripe",
      group: "Head",
      lookFor: "The pale stripe between the ear coverts and the malar stripe. Together they make the striped face of many sparrows.",
    },
    {
      id: "malar",
      name: "Malar stripe",
      aka: "whisker, lateral throat stripe",
      group: "Head",
      lookFor: "A stripe running down from the base of the bill along the side of the throat. Note whether it's there, and how dark and how wide it is.",
    },
    {
      id: "chin",
      name: "Chin",
      group: "Head",
      lookFor: "The small area just below the bill. It usually matches the throat; a chin that contrasts is worth noting.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor: "Below the chin, between the malar stripes. A white, yellow or black throat is often one of the first things to check.",
    },
    // Bill & legs
    {
      id: "upper-mandible",
      name: "Upper mandible",
      group: "Bill & legs",
      lookFor:
        "The upper half of the bill. Start with bill shape: a sparrow's short cone is built for seeds, a warbler's thin point for insects.",
    },
    {
      id: "lower-mandible",
      name: "Lower mandible",
      group: "Bill & legs",
      lookFor: "The lower half of the bill. Its colour sometimes differs from the upper mandible's, often paler below.",
    },
    {
      id: "legs",
      name: "Legs and feet",
      group: "Bill & legs",
      lookFor: "Leg colour (pink, yellow, dark) is a quick check on a perched bird.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "The upper body between the nape and the rump. Note its colour and whether it's streaked.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers lying along the top of the folded wing, between the back and the wing coverts.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "The lower back, just above the tail. A contrasting rump, such as a yellow-rumped warbler's, is a strong mark.",
      visibility: "Often covered by the folded wings on a perched bird; easiest to see when it flies.",
    },
    // Wing
    {
      id: "wing",
      name: "Wing (folded)",
      group: "Wing",
      lookFor:
        "On a perched songbird you see mostly the wing coverts, the tertials and the tips of the primaries; each of these feather groups has its own name below.",
    },
    {
      id: "wing-bars",
      name: "Wing bars",
      group: "Wing",
      lookFor:
        "Pale bars across the folded wing, formed in most songbirds by pale tips on the median and greater coverts. Count them (none, one or two) and note their colour.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor:
        "Small feathers at the front of the wing. A few species have a coloured patch here, such as the male Red-winged Blackbird's red shoulder.",
      visibility: "Often hidden by the scapulars and breast feathers on a perched bird.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small feather group on the bird's 'thumb', at the bend of the wing. Rarely an ID mark, but a useful landmark.",
      visibility: "Small and often hidden at rest.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor: "The row of coverts between the lesser and greater coverts. Their pale tips make the upper wing bar.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The longest row of coverts, lying over the bases of the secondaries. Their pale tips make the lower wing bar.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor: "The inner flight feathers. On a folded wing they show below the tertials; pale edges here can form a pale wing panel.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "The innermost flight feathers, lying on top of the folded wing near the back. Note their edges and their length against the primaries.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The long outer flight feathers. On a folded wing only their tips show past the tertials; how far they reach (primary projection) helps separate some look-alikes, such as the small flycatchers.",
    },
    // Underparts
    {
      id: "breast",
      name: "Breast",
      group: "Underparts",
      lookFor: "Below the throat. Note streaks or spots, and whether they gather into a central spot, as on a Song Sparrow.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "Between the breast and the legs. Often paler and plainer than the breast; note where any streaking stops.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor: "The sides of the body, below the folded wing. Streaks or a coloured wash here help separate many look-alikes.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the base of the tail. Their colour (white, buff, yellow, rusty) is easy to miss and often helps.",
    },
    // Tail
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Note its length against the body, the shape of the tip (notched, square, rounded) and any white in the outer feathers, which flashes in flight.",
    },
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Tail",
      lookFor: "The feathers covering the base of the tail from above, just behind the rump. Their colour sometimes differs from the rump's.",
      visibility: "Usually hidden under the wingtips on a perched songbird.",
    },
    {
      id: "rectrices",
      name: "Tail feathers",
      aka: "rectrices",
      group: "Tail",
      lookFor: "The tail's flight feathers, in pairs from the centre outward. Pale or white outer feathers show best when the tail spreads.",
    },
  ],
};
