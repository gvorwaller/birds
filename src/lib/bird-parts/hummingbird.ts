import type { DiagramText } from "./types";

export const hummingbird: DiagramText = {
  id: "hummingbird",
  title: "Hummingbird",
  model: { species: "Ruby-throated Hummingbird", age: "adult male", pose: "perched" },
  intro:
    "Drawn from an adult male Ruby-throated Hummingbird perched on a wire. It is 7 to 9 cm long, metallic green above and grayish white below, with near-black wings and a long, straight, slender bill. Hummingbirds share their order, Apodiformes (\"footless\"), with the swifts. Look at the throat patch (the gorget), the crown, the tail's shape and pattern, and the bill.",
  sources: [
    {
      label: "20240707 ruby throated hummingbird bafflin sanctuary PD204642 36.jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:20240707_ruby_throated_hummingbird_bafflin_sanctuary_PD204642_36.jpg",
      credit: "Paul Danese, CC BY-SA 4.0",
    },
    {
      label: "Ruby Throated Hummingbird 1.jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Ruby_Throated_Hummingbird_1.jpg",
      credit: "John Kees, CC BY-SA 3.0",
    },
    {
      label: "Ruby hummingbird (4975523938).jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Ruby_hummingbird_(4975523938).jpg",
      credit: "Eric Kilby, CC BY-SA 2.0",
    },
    { label: "Ruby-throated hummingbird (Wikipedia)", url: "https://en.wikipedia.org/wiki/Ruby-throated_hummingbird" },
    { label: "Hummingbird (Wikipedia)", url: "https://en.wikipedia.org/wiki/Hummingbird" },
    { label: "Apodiformes (Wikipedia)", url: "https://en.wikipedia.org/wiki/Apodiformes" },
    { label: "Swift (Wikipedia)", url: "https://en.wikipedia.org/wiki/Swift_(bird)" },
    { label: "Common swift (Wikipedia)", url: "https://en.wikipedia.org/wiki/Common_swift" },
    { label: "Black-chinned hummingbird (Wikipedia)", url: "https://en.wikipedia.org/wiki/Black-chinned_hummingbird" },
    { label: "Allen's hummingbird (Wikipedia)", url: "https://en.wikipedia.org/wiki/Allen%27s_hummingbird" },
    { label: "White-eared hummingbird (Wikipedia)", url: "https://en.wikipedia.org/wiki/White-eared_hummingbird" },
    { label: "Glossary of bird terms: gorget (Wikipedia)", url: "https://en.wikipedia.org/wiki/Glossary_of_bird_terms" },
    { label: "Ruby-throated Hummingbird (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/ruby-throated-hummingbird" },
    { label: "Black-chinned Hummingbird (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/black-chinned-hummingbird" },
    { label: "Anna's Hummingbird (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/annas-hummingbird" },
    { label: "Costa's Hummingbird (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/costas-hummingbird" },
    { label: "Rufous Hummingbird (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/rufous-hummingbird" },
    { label: "Calliope Hummingbird (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/calliope-hummingbird" },
    { label: "Broad-tailed Hummingbird (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/broad-tailed-hummingbird" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor:
        "Metallic green on a Ruby-throated. On some males the crown shines like the throat: a male Anna's Hummingbird is rose red on both crown and throat, and a male Costa's purple on both.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor: "Metallic green on a Ruby-throated, like the back.",
    },
    {
      id: "face",
      name: "Face",
      group: "Head",
      lookFor:
        "The front of the head, seen from below in flight. Dark on a male Ruby-throated. A male Black-chinned Hummingbird has a black face and chin above its purple gorget.",
      visibility: "Drawn from below in flight. On the perched bird the face is named part by part: lores, supercilium, eye-line, ear coverts and malar.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor: "Between the eye and the base of the bill. Dark on this male Ruby-throated, like the rest of the face.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor: "The band above the eye. On this Ruby-throated it is metallic green like the crown, with no pale stripe.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor: "The band through the eye, from the bill back past the small white spot. Dark on this male, part of its dark face.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor: "The thin ring of feathers around the eye. Dark on this Ruby-throated, so the eye shows no pale ring.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor: "The patch behind and below the eye, over the ear. Dark on a male Ruby-throated, the back of its dark face.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor:
        "From the base of the lower bill back along the side of the throat, down to the top of the gorget. Dark on this male: the ruby gorget is bordered narrowly with velvety black along its upper edge. It shows no stripe of its own.",
    },
    {
      id: "post-ocular-spot",
      name: "Spot behind the eye",
      aka: "postocular spot",
      group: "Head",
      lookFor:
        "A small white spot just behind the eye, easy to miss. On some hummingbirds the mark is much bolder: a breeding male White-eared Hummingbird has a wide white stripe behind the eye.",
      visibility: "Small; easiest to pick from the list.",
    },
    {
      id: "gorget",
      name: "Gorget",
      aka: "throat patch",
      group: "Head",
      lookFor:
        "The iridescent throat patch of many male hummingbirds, particularly North American ones. Its colour depends on the angle of the light: a Ruby-throated's ruby red looks dull black from many angles. Compare a male Black-chinned (a purple band below the black chin, hard to see), Anna's (rose red, on the crown too), Costa's (purple, extending back to a point), Rufous (a dark throat that shines red in good light), Allen's (orange-red), Calliope (smeary magenta stripes) and Broad-tailed (rose). Female Ruby-throated and Black-chinned have no gorget: a female Ruby-throated's throat is white, plain or lightly marked with dusky streaks or stipples, and a female Anna's often has red spots on the throat.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Long, straight and slender on a Ruby-throated, up to 2 cm; males have slightly shorter bills than females. Hummingbird bills range from straight to strongly curved. Bill length helps with females: a female Costa's has a shorter bill than a female Anna's or Black-chinned, and a female Calliope a shorter bill than a female Rufous.",
    },
    {
      id: "toes",
      name: "Feet",
      aka: "legs and toes",
      group: "Bill & legs",
      lookFor:
        "Short legs with three toes pointing forward and one back; the short lower leg is the tarsus. A Ruby-throated can only shuffle along a branch, not walk or hop, though it can preen by scratching with its feet. A Common Swift's very short legs are used mainly for clinging to vertical surfaces.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor:
        "Metallic green on a Ruby-throated; a female is golden-green above. A male Rufous Hummingbird is bright coppery rufous above, while a male Allen's has a green back. Some male Rufous are green-backed too, and are hard to tell from Allen's.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "Green on a Ruby-throated. A male Allen's has a rufous rump and tail.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor: "The small feathers covering the base of the wing, shown here as one area.",
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
      lookFor:
        "Coverts lying over the bases of the primaries. A hummingbird's wing has no alula, the small group of feathers at the bend of the wing in the other drawings.",
      visibility: "Seen in flight from above.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the inner wing. Hummingbirds and swifts evolved long wings with a short, stout upper-arm bone.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the hand, forming the long, blade-like outer wing; a Ruby-throated's wings are near-black. The wings rotate nearly 180° at the shoulder, so a hummingbird can hover and fly backward; hovering, they beat up to 80 times a second. The tapered tips of the ninth and tenth primaries make the wing trill of male Rufous and Broad-tailed Hummingbirds. A swift's wings are narrow and swept back like a crescent or a boomerang.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor: "The feathers lining the underside of the wing, over the bases of the flight feathers.",
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
        "Grayish white on a Ruby-throated, white just below the male's gorget. A female Calliope often has a pale buff wash right across the chest.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor:
        "Metallic green on a male Ruby-throated. Rufous here points to the Rufous and Allen's Hummingbirds: a male Allen's has rufous flanks, and female and young Rufous an orange-buff wash on the sides.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "Grayish white on a Ruby-throated. A female Anna's is dingy gray below.",
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
      lookFor: "The feathers lying over the base of the tail, metallic green on a Ruby-throated like the rump.",
    },
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Forked and black, with a faint violet sheen, on an adult male Ruby-throated. A female's tail is notched, its outer feathers banded green, black and white, with white tips. A female Black-chinned, with a dark rounded tail with white tips, is almost identical to a female Ruby-throated. Watch the tail while the bird hovers: a Black-chinned flips and spreads it, an Anna's tends to hold it still. Many swifts have a short, forked tail.",
    },
  ],
};
