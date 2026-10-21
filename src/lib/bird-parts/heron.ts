import type { DiagramText } from "./types";

export const heron: DiagramText = {
  id: "heron",
  title: "Heron",
  model: { species: "Great Blue Heron", age: "adult breeding", pose: "standing" },
  intro:
    "Drawn from an adult Great Blue Heron in breeding plumage, the largest heron native to North America. Herons, egrets and bitterns are long-legged waders: look at the colour of the bill, lores and legs, the neck pattern and plumes, and how the bird holds its neck in flight. Herons fold it back; storks, ibises, spoonbills and cranes stretch it out.",
  sources: [
    {
      label: "Ardea herodias standing on a rock at St. Pete Beach.JPG (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Ardea_herodias_standing_on_a_rock_at_St._Pete_Beach.JPG",
      credit: "Grendelkhan, CC BY-SA 4.0",
    },
    {
      label: "Ardea herodias -Illinois, USA -flying-8.jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Ardea_herodias_-Illinois,_USA_-flying-8.jpg",
      credit: "PhotoBobil, CC BY 2.0",
    },
    { label: "Great blue heron (Wikipedia)", url: "https://en.wikipedia.org/wiki/Great_blue_heron" },
    { label: "Heron (Wikipedia)", url: "https://en.wikipedia.org/wiki/Heron" },
    { label: "Crane (bird) (Wikipedia)", url: "https://en.wikipedia.org/wiki/Crane_(bird)" },
    { label: "Grey heron (Wikipedia)", url: "https://en.wikipedia.org/wiki/Grey_heron" },
    { label: "Great egret (Wikipedia)", url: "https://en.wikipedia.org/wiki/Great_egret" },
    { label: "Snowy egret (Wikipedia)", url: "https://en.wikipedia.org/wiki/Snowy_egret" },
    { label: "Snowy Egret (Mass Audubon Breeding Bird Atlas)", url: "https://www.massaudubon.org/our-work/birds-wildlife/bird-conservation-research/breeding-bird-atlases/find-a-bird-bba1?id=35" },
    { label: "Aigrette (Wikipedia)", url: "https://en.wikipedia.org/wiki/Aigrette" },
    { label: "Bird anatomy: legs (Wikipedia)", url: "https://en.wikipedia.org/wiki/Bird_anatomy" },
    { label: "Glossary of bird terms: axillaries, underwing (Wikipedia)", url: "https://en.wikipedia.org/wiki/Glossary_of_bird_terms" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor: "Pale on an adult Great Blue Heron, between its black head stripes. A young bird has a dull blackish-gray crown instead.",
    },
    {
      id: "head-plumes",
      name: "Head plumes",
      group: "Head",
      lookFor:
        "A pair of black plumes running from just above the eye to the back of the head, ending in long plumes off the nape. Young Great Blue Herons have no plumes.",
    },
    {
      id: "face",
      name: "Face",
      group: "Head",
      lookFor: "Nearly white on an adult Great Blue Heron. A Grey Heron in Europe has a similar white face with a black stripe.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor:
        "The bare skin between the eye and the bill. Its colour helps with the white egrets: an adult Snowy Egret's lores are usually yellow, between a black bill and the eye, but a male displaying in the breeding season has orange or red lores and feet.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor:
        "A thin ring of feathers just outside the eye. Nearly white on an adult Great Blue Heron, like the face around it.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "orbital-ring",
      name: "Orbital ring",
      aka: "bare eye-ring",
      group: "Head",
      lookFor:
        "The bare skin right around the eye, inside the feathered eye-ring. Drawn in the face's pale tone on this adult Great Blue Heron.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor:
        "The area above the eye, from the bill back. On an adult Great Blue Heron the black head plume starts just above the eye and runs back from it; the rest is white.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor:
        "A band through the eye, from the bill back to behind the eye. White behind the eye on an adult Great Blue Heron, with no dark line.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor:
        "The feathers behind and below the eye, over the ear. White on an adult Great Blue Heron, like the rest of the face.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor:
        "The area along the lower edge of the face, from the base of the lower bill back. White on an adult Great Blue Heron, with no dark stripe.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "throat",
      name: "Throat",
      group: "Head",
      lookFor: "Below the bill, white like the rest of the face on this adult.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Long and dagger-like for spearing fish and frogs. Dull yellowish on an adult Great Blue Heron, briefly orange at the start of the breeding season. Bill colour helps with the white egrets: an American Great Egret's is yellow (it can darken in the breeding season, and Great Egrets elsewhere differ), while a Snowy Egret's is black.",
    },
    {
      id: "tibia",
      name: "Tibia",
      aka: "upper leg",
      group: "Bill & legs",
      lookFor:
        "The leg above the backward-bending joint. On almost every heron the feathers stop partway down it, so its lower part is bare.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "lower leg",
      group: "Bill & legs",
      lookFor:
        "Part of a bird's foot, so the joint above it that seems to bend backward is an ankle, not a knee. Gray on an adult Great Blue Heron, briefly orangey early in the breeding season. Leg colour helps with the big white herons: an American Great Egret's legs are black (the lower legs can turn paler in the breeding season), while the white Florida form of Great Blue Heron (the 'Great White Heron') has yellow legs.",
      visibility: "In flight a heron's legs trail straight back, past the tail.",
    },
    {
      id: "toes",
      name: "Toes",
      group: "Bill & legs",
      lookFor: "Long and thin, three forward and one back. An adult Snowy Egret has bright yellow feet on black legs.",
    },
    // Upperparts
    {
      id: "hindneck",
      name: "Hindneck",
      group: "Upperparts",
      lookFor:
        "Rusty gray on a Great Blue Heron. The Grey Heron of Europe and Asia, its close relative, has a plain soft-gray neck without the brown.",
    },
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "Gray on this adult.",
      visibility: "Covered by the plumes and folded wings on a standing heron; seen in flight from above.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "Shoulder feathers lying over the base of each wing; gray on this adult.",
      visibility: "Covered by the back plumes on a standing heron; seen in flight from above.",
    },
    {
      id: "back-plumes",
      name: "Back plumes",
      group: "Upperparts",
      lookFor:
        "Long plumes on the lower back at the start of the breeding season. Egrets grow showy breeding plumes too; around 1900 so many egrets were shot for plumes ('aigrettes') to decorate hats that their numbers crashed.",
      visibility: "Breeding season only.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "Between the back and the tail; gray on this adult.",
      visibility: "Covered by the wings on a standing heron; seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The rows of smaller feathers covering the wing, shown here as one area. Gray on an adult Great Blue Heron, paler than the slaty flight feathers, so the open wing looks two-toned.",
    },
    {
      id: "wing-bars",
      name: "Wing bars",
      aka: "wingbar",
      group: "Wing",
      lookFor:
        "Where a wing bar runs: across the wing at the tips of the greater coverts. None on an adult Great Blue Heron, whose coverts are plain gray.",
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
      visibility: "Hidden on a standing heron; seen in flight.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A small group of feathers on the bird's 'thumb', at the bend of the wing. A landmark rather than an ID mark.",
      visibility: "Hidden on a standing heron; seen in flight.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor: "The flight feathers of the inner wing. Slaty on an adult Great Blue Heron, darker than the coverts.",
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
        "The flight feathers of the hand: slaty, the darkest part of a Great Blue Heron's wing. A heron's wings are broad, with rounded tips.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor: "The feathers covering the underside of the wing in front of the flight feathers.",
      visibility: "Seen in flight, or when a bird raises its wings.",
    },
    {
      id: "axillaries",
      name: "Axillaries",
      aka: "wingpits",
      group: "Wing",
      lookFor: "Feathers in the 'armpit', where the underwing meets the body.",
      visibility: "Seen in flight, or when a bird raises its wings.",
    },
    // Underparts
    {
      id: "foreneck",
      name: "Foreneck",
      group: "Underparts",
      lookFor:
        "Black-and-white streaks run down the front of a Great Blue Heron's neck. In flight a heron folds its neck back into an S, so the neck bulges below the head; storks, ibises, spoonbills and cranes fly with the neck stretched out.",
    },
    {
      id: "breast-plumes",
      name: "Breast plumes",
      group: "Underparts",
      lookFor: "Long, plume-like feathers on the lower neck that hang over the breast.",
    },
    {
      id: "flank-stripe",
      name: "Flank stripe",
      group: "Underparts",
      lookFor:
        "A paired red-brown and black stripe up the flanks of an adult Great Blue Heron. It is only weakly marked on young birds.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "Below the breast plumes, between the flank stripes.",
    },
    {
      id: "thighs",
      name: "Thighs",
      group: "Underparts",
      lookFor: "The feathered top of the legs: red-brown on an adult Great Blue Heron.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the short tail.",
      visibility: "Seen in flight from below.",
    },
    // Tail
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Tail",
      lookFor:
        "The feathers lying over the base of the tail. Gray on this adult, like the rump.",
      visibility: "Seen in flight from above.",
    },
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor: "Short and gray. A heron's legs trail past it in flight.",
      visibility: "Mostly hidden under the wingtips on a standing heron; seen in flight.",
    },
  ],
};
