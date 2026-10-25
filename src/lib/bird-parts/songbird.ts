import type { DiagramText } from "./types";

export const songbird: DiagramText = {
  id: "songbird",
  title: "Songbird",
  model: { species: "Song Sparrow", age: "adult", pose: "perched" },
  intro:
    "A typical songbird, shaped after an adult Song Sparrow. Some marks, such as the two wing bars, are drawn to show where they appear on the many songbirds that have them. A few marks of other birds, such as a hawk's cere or a duck's speculum, are outlined to show where they would sit.",
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
    { label: "Glossary of bird terms: axillaries, underwing (Wikipedia)", url: "https://en.wikipedia.org/wiki/Glossary_of_bird_terms" },
    { label: "Rose-breasted grosbeak (Wikipedia)", url: "https://en.wikipedia.org/wiki/Rose-breasted_grosbeak" },
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
      id: "nasal-tufts",
      name: "Nasal tufts",
      aka: "nasal bristles",
      group: "Head",
      lookFor:
        "Small feathers lying forward over the nostrils at the base of the upper bill. Tiny on this sparrow; on some birds they are thick and bristly and hide the nostrils.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor:
        "A ring of feathers around the eye. Note whether it's complete, broken at the front and back, or missing, and whether it's bold or faint.",
    },
    {
      id: "orbital-ring",
      name: "Orbital ring",
      group: "Head",
      lookFor:
        "The ring of bare skin right around the eye, inside the feathered eye-ring. Thin and plain on this songbird; where it's coloured, note the colour.",
      visibility: "Small; easiest to pick from the list.",
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
      id: "gonys",
      name: "Gonys",
      group: "Bill & legs",
      lookFor:
        "The ridge along the underside of the lower mandible towards the tip, where the two halves of the lower jaw join. On a short, conical bill like this one it is barely noticeable.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "cere",
      name: "Cere",
      group: "Bill & legs",
      lookFor:
        "The bare, often coloured, fleshy saddle at the base of the upper bill on birds such as pigeons, parrots and hawks. A songbird has none, so this area only marks where a cere would sit.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "legs",
      name: "Legs and feet",
      group: "Bill & legs",
      aka: "tarsus and toes",
      lookFor: "Leg colour (pink, yellow, dark) is a quick check on a perched bird. The bare part of the leg is the tarsus.",
    },
    {
      id: "tibia",
      name: "Tibia",
      group: "Bill & legs",
      lookFor:
        "The leg between the knee and the bare tarsus. On a songbird it is feathered and tucked into the belly feathers, so only its lower end shows; long-legged waders show it bare.",
      visibility: "Small; easiest to pick from the list.",
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
      name: "Wing",
      group: "Wing",
      lookFor:
        "The whole wing as one area; each of its feather groups has its own name. Folded on a perched songbird, it shows mostly the coverts, the tertials and the primary tips. Spread in flight, the same groups lie in rows from the front edge back.",
    },
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The rows of smaller feathers covering the bases of the flight feathers, shown here as one area: the lesser, median and greater coverts on the perched bird, and in flight from above the primary coverts and the alula too. Pale tips on the median and greater coverts make the wing bars. Choose All feather groups to see each row.",
    },
    {
      id: "wing-bars",
      name: "Wing bars",
      group: "Wing",
      lookFor:
        "Pale bars across the folded wing. In the usual two-bar songbird pattern, pale tips on the median and greater coverts form them. Count them (none, one or two) and note their colour.",
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
      id: "primary-coverts",
      name: "Primary coverts",
      group: "Wing",
      lookFor:
        "Coverts lying over the bases of the primaries, just behind the alula on the lower edge of the folded wing. Usually a small, dark patch at rest.",
      visibility: "Small on a folded wing; easier to see in flight.",
    },
    {
      id: "median-coverts",
      name: "Median coverts",
      group: "Wing",
      lookFor: "The row of coverts between the lesser and greater coverts. When their tips are pale, they form the upper wing bar.",
    },
    {
      id: "greater-coverts",
      name: "Greater coverts",
      group: "Wing",
      lookFor: "The longest row of coverts, lying over the bases of the secondaries. When their tips are pale, they form the lower wing bar.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor: "The inner flight feathers. On a folded wing they show below the tertials; pale edges here can form a pale wing panel.",
    },
    {
      id: "speculum",
      name: "Speculum",
      group: "Wing",
      lookFor:
        "A bright, often glossy patch on the secondaries, shown best in flight, as on many ducks. This songbird's secondaries are plain, so this area only marks where a speculum would be.",
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
        "The long outer flight feathers. On a folded wing they lie beneath the secondaries, so you see their outer edges along the bottom of the wing and their tips past the tertials. How far the tips reach (primary projection) helps separate some look-alikes, such as the small flycatchers.",
    },
    {
      id: "primary-projection",
      name: "Primary projection",
      group: "Wing",
      lookFor:
        "How far the primary tips reach past the tertials on the folded wing. A long projection means long wings, and it helps separate some look-alikes, such as the small flycatchers.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor:
        "Small feathers covering the underside of the wing in front of the flight feathers. Plain and pale on most songbirds, but a contrasting colour can help from below, such as the rosy wing linings of a male Rose-breasted Grosbeak.",
      visibility: "Seen in flight, or when a bird raises its wings.",
    },
    {
      id: "axillaries",
      name: "Axillaries",
      aka: "wingpits",
      group: "Wing",
      lookFor:
        "Feathers in the 'armpit', where the underwing meets the body. On songbirds they usually match the wing linings; on some other birds they're a key mark, such as a Black-bellied Plover's black wingpits.",
      visibility: "Seen in flight, or when a bird raises its wings.",
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
      id: "belly-band",
      name: "Belly band",
      group: "Underparts",
      lookFor:
        "A band of colour across the belly, below the breast. Plain on this sparrow, whose belly is all one colour.",
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
