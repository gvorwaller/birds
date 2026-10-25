import type { DiagramText } from "./types";

export const parrot: DiagramText = {
  id: "parrot",
  title: "Parrot",
  model: { species: "Rose-ringed Parakeet (northern Indian subspecies, P. k. borealis)", age: "adult male", pose: "perched" },
  intro:
    "Drawn from an adult male Rose-ringed (Ring-necked) Parakeet of the subspecies borealis, perched. It is 37 to 43 cm long, much of that the tail, and green, with a red bill and pale eyes; the male wears a black bib and a narrow black-and-rose ring round the neck. Native to Africa and India, escaped cage birds now breed in many cities, from London and Paris to Los Angeles and Florida. Parrots share a strong, hooked bill, a cere at its base, and zygodactyl feet: two toes forward and two back, shown in the foot close-up; the head close-up shows the small face parts larger. Look at the bill, the face and neck, the bare skin round the eye, the wing in flight, and the tail's length and colour.",
  sources: [
    {
      label: "Rose-ringed parakeet (Psittacula krameri borealis) male Jaipur.jpg (reference photo, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Rose-ringed_parakeet_(Psittacula_krameri_borealis)_male_Jaipur.jpg",
      credit: "Charles J. Sharp, CC BY-SA 4.0",
    },
    {
      label: "Rose-ringed Parakeet Psittacula krameri male by Dr. Raju Kasambe DSCN8937 (3).jpg (reference photo for the neck ring, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Rose-ringed_Parakeet_Psittacula_krameri_male_by_Dr._Raju_Kasambe_DSCN8937_(3).jpg",
      credit: "Dr. Raju Kasambe, CC BY-SA 4.0",
    },
    {
      label: "A Rose Ringed Parakeet flying over a Field (51378028489).jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:A_Rose_Ringed_Parakeet_flying_over_a_Field_(51378028489).jpg",
      credit: "Hari K Patibanda, CC BY 2.0",
    },
    {
      label: "Flock of Rose-ringed Parakeets flying to roost, Lucknow, India (138193243).jpg (reference photo for the flight views, proportions only)",
      url: "https://commons.wikimedia.org/wiki/File:Flock_of_Rose-ringed_Parakeets_flying_to_roost,_Lucknow,_India_(138193243).jpg",
      credit: "Alexandre Ultré, CC BY-SA 3.0",
    },
    { label: "Rose-ringed parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Rose-ringed_parakeet" },
    { label: "Halsbandsittich (German Wikipedia)", url: "https://de.wikipedia.org/wiki/Halsbandsittich" },
    { label: "Rose-ringed Parakeet (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/rose-ringed-parakeet" },
    { label: "Rose-ringed Parakeet (Oiseaux-Birds)", url: "https://www.oiseaux-birds.com/card-rose-ringed-parakeet.html" },
    { label: "Parrot (Wikipedia)", url: "https://en.wikipedia.org/wiki/Parrot" },
    { label: "Psittacula (Wikipedia)", url: "https://en.wikipedia.org/wiki/Psittacula" },
    { label: "Beak: cere (Wikipedia)", url: "https://en.wikipedia.org/wiki/Beak#Cere" },
    { label: "Zygodactyly (Wikipedia)", url: "https://en.wikipedia.org/wiki/Zygodactyly" },
    { label: "Glossary of bird terms (Wikipedia)", url: "https://en.wikipedia.org/wiki/Glossary_of_bird_terms" },
    { label: "Echo parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Echo_parakeet" },
    { label: "Alexandrine parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Alexandrine_parakeet" },
    { label: "Plum-headed parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Plum-headed_parakeet" },
    { label: "Monk parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Monk_parakeet" },
    { label: "Monk Parakeet (Audubon Field Guide)", url: "https://www.audubon.org/field-guide/bird/monk-parakeet" },
    { label: "Blue-crowned parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Blue-crowned_parakeet" },
    { label: "Nanday parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Nanday_parakeet" },
    { label: "Green parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Green_parakeet" },
    { label: "Mitred parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Mitred_parakeet" },
    { label: "Red-masked parakeet (Wikipedia)", url: "https://en.wikipedia.org/wiki/Red-masked_parakeet" },
    { label: "Budgerigar (Wikipedia)", url: "https://en.wikipedia.org/wiki/Budgerigar" },
    { label: "Amazon parrot (Wikipedia)", url: "https://en.wikipedia.org/wiki/Amazon_parrot" },
    { label: "Lilac-crowned amazon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Lilac-crowned_amazon" },
    { label: "Yellow-crowned amazon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Yellow-crowned_amazon" },
    { label: "Red-crowned amazon (Wikipedia)", url: "https://en.wikipedia.org/wiki/Red-crowned_amazon" },
    { label: "Cockatoo (Wikipedia)", url: "https://en.wikipedia.org/wiki/Cockatoo" },
    { label: "Kea (Wikipedia)", url: "https://en.wikipedia.org/wiki/Kea" },
    { label: "Kākāpō (Wikipedia)", url: "https://en.wikipedia.org/wiki/K%C4%81k%C4%81p%C5%8D" },
  ],
  parts: [
    // Head
    {
      id: "crown",
      name: "Crown",
      group: "Head",
      lookFor:
        "Green on a Rose-ringed Parakeet. Head colour sorts many parakeets: a male Plum-headed Parakeet's head is red shading to purple-blue, a Blue-crowned Parakeet's forehead and crown are dull blue, a Monk Parakeet's forehead is pale grey, and the Mitred Parakeet has a red forecrown.",
    },
    {
      id: "nape",
      name: "Nape",
      group: "Head",
      lookFor:
        "The back of the head, above the neck ring. On a male Rose-ringed it often has a faint bluish wash, an indistinct crescent above the ring. An Alexandrine Parakeet has a light blue-grey sheen on the cheeks and nape.",
    },
    {
      id: "face",
      name: "Face",
      group: "Head",
      lookFor:
        "The front of the head, seen from below in flight: green on a Rose-ringed, with the black bib under the bill. A Nanday Parakeet has a black face mask, and a Red-masked Parakeet a mostly red head.",
      visibility: "Drawn from below in flight. On the perched bird the face is named part by part: lores, supercilium, eye-line, ear coverts and malar.",
    },
    {
      id: "lores",
      name: "Lores",
      group: "Head",
      lookFor:
        "Between the eye and the base of the bill. A male Rose-ringed has a black stripe through the lores, which the female lacks; the male Echo Parakeet of Mauritius has a narrow black line from the cere to the eye.",
      visibility: "Small on the bird; larger in the head close-up.",
    },
    {
      id: "supercilium",
      name: "Supercilium",
      aka: "eyebrow",
      group: "Head",
      lookFor: "The band above the eye. Plain green on a Rose-ringed Parakeet, with no stripe.",
    },
    {
      id: "eye-line",
      name: "Eye-line",
      aka: "eyestripe",
      group: "Head",
      lookFor: "The band through and behind the eye. Plain green on a Rose-ringed Parakeet; the male's only line on the face runs in front of the eye, in the lores.",
    },
    {
      id: "eye-ring",
      name: "Eye-ring",
      group: "Head",
      lookFor:
        "The feathers ringing the eye, outside the bare skin. Green on this parakeet, so the eye shows only its ring of bare skin. Parrot texts often say \"eye-ring\" for that bare skin (the orbital ring): a Red-masked Parakeet's elongated pale eye-ring is conspicuous, and a Red-crowned Amazon has a white eye-ring.",
      visibility: "Small on the bird; larger in the head close-up.",
    },
    {
      id: "orbital-ring",
      name: "Orbital ring",
      aka: "bare skin round the eye",
      group: "Head",
      lookFor:
        "The ring of bare skin right around the eye, round this parakeet's pale iris. Its colour helps with many parrots: a Blue-crowned Parakeet has a ring of white featherless skin (bright orange-yellow in one wild subspecies), a Mitred Parakeet bare white skin, a Green Parakeet bare pale beige skin round an orange-red iris, a Lilac-crowned Amazon pale brown-grey rings, and an Echo Parakeet orange skin. An adult Kea's eye-rings are grey, a young one's yellow. Some cockatoos have a large bare patch round the eye: the Palm Cockatoo's red patch covers part of the face.",
      visibility: "Small on the bird; larger in the head close-up.",
    },
    {
      id: "ear-coverts",
      name: "Ear coverts",
      aka: "auriculars",
      group: "Head",
      lookFor: "The cheek behind and below the eye, over the ear. Green on a Rose-ringed, bordered below by the black neck ring. On some Mitred Parakeets red flecks reach the ear coverts.",
    },
    {
      id: "malar",
      name: "Malar",
      aka: "moustache area",
      group: "Head",
      lookFor:
        "Below the eye, back from the base of the bill. Green on this male, down to the black bib. A male Alexandrine Parakeet has a black stripe across the lower cheeks, which the female lacks.",
    },
    {
      id: "throat",
      name: "Throat",
      aka: "chin, bib",
      group: "Head",
      lookFor:
        "Under the bill. A male Rose-ringed has a black bib here, the front of its neck ring; a female, which lacks the ring, has no bib. A male Plum-headed Parakeet has a black chin stripe running from the lower mandible.",
    },
    {
      id: "neck-ring",
      name: "Neck ring",
      aka: "collar",
      group: "Head",
      lookFor:
        "The adult male's narrow collar: black from the bib round under the cheeks to the sides of the nape, where it tapers, with a rose-pink line behind it across the nape. It comes in at about two years old, sometimes after one. Females and young birds have no ring, or only a shadowy pale to dark grey one. A male Alexandrine Parakeet has a pink band on the nape and a black cheek stripe, and is much larger, with a red shoulder patch; a male Plum-headed has a narrow black collar with verdigris below it; a male Echo Parakeet has a black and a pink collar that do not meet at the back.",
    },
    // Bill & legs
    {
      id: "bill",
      name: "Bill",
      group: "Bill & legs",
      lookFor:
        "Deep and hooked, as in all parrots: the upper mandible curves down to a point and is not fused to the skull, and the shorter lower mandible has a sharp, upward cutting edge that works against it. The subspecies differ in the bill: the African nominate's upper mandible is dark red to almost black and its lower mostly black; the Asian manillensis has a red upper and a mostly black lower mandible with a reddish tip; borealis, the bird drawn here, a red upper and a reddish lower mandible. Feral birds in Britain, Germany and Spain, and likely elsewhere, descend from a mix of manillensis and borealis. Compare a Monk Parakeet's orange bill, a Blue-crowned's horn-coloured bill with a grey-black tip, a Plum-headed's orange-yellow upper mandible, a Nanday's black bill, and an Alexandrine's massive red bill with yellow tips.",
    },
    {
      id: "cere",
      name: "Cere",
      group: "Bill & legs",
      lookFor:
        "The waxy saddle across the base of the upper bill, holding the nostrils. In parrots it is sometimes feathered, but usually bare and often coloured. A budgerigar's cere tells the sexes apart: blue in males, pale brownish or white in females (brown when breeding), pink in young birds. Amazons have a prominent bare cere; an adult Kea's is grey and a young one's yellow; a female Kākāpō has a smaller cere than a male.",
      visibility: "Small on the bird; larger in the head close-up.",
    },
    {
      id: "tarsus",
      name: "Tarsus",
      aka: "lower leg",
      group: "Bill & legs",
      lookFor: "The short, bare lower leg. Greyish on a Rose-ringed Parakeet; parrots have short legs and a waddling walk.",
      visibility: "Small; clearer in the close-up of the foot.",
    },
    {
      id: "toes",
      name: "Toes",
      aka: "zygodactyl foot",
      group: "Bill & legs",
      lookFor:
        "Zygodactyl: two toes forward and two back (the second and third forward, the first and fourth back), with sharp claws, for climbing and for holding food like a hand; in a study of Australian parrots almost every adult was either left- or right-footed. Woodpeckers and cuckoos have the same arrangement. Grey on a Rose-ringed; a Blue-crowned Parakeet's feet are pink-brown, a Kākāpō's large and blue.",
    },
    // Upperparts
    {
      id: "back",
      name: "Back",
      group: "Upperparts",
      lookFor: "Green on a Rose-ringed Parakeet. Most amazons and many parakeets are green above, so the face, wing and tail marks do most of the work.",
    },
    {
      id: "scapulars",
      name: "Scapulars",
      group: "Upperparts",
      lookFor: "The feathers over the base of the wing, along each side of the back. Green on a Rose-ringed, like the back.",
    },
    {
      id: "rump",
      name: "Rump",
      group: "Upperparts",
      lookFor: "Green on a Rose-ringed. A Plum-headed Parakeet's rump and tail are bluish green.",
      visibility: "Seen in flight from above.",
    },
    // Wing
    {
      id: "wing-coverts",
      name: "Wing coverts",
      group: "Wing",
      lookFor:
        "The feathers covering the base of the wing, shown here as one area. Green on a Rose-ringed. A red shoulder patch on the coverts marks the Alexandrine and the male Plum-headed Parakeet.",
    },
    {
      id: "lesser-coverts",
      name: "Lesser coverts",
      group: "Wing",
      lookFor: "The small feathers at the front of the wing, nearest the shoulder.",
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
      id: "wing-bars",
      name: "Wing bars",
      group: "Wing",
      lookFor:
        "Pale or dark tips to the covert rows that show as bars across the wing. A Rose-ringed Parakeet has none, so this area only marks where they would sit.",
    },
    {
      id: "primary-coverts",
      name: "Primary coverts",
      group: "Wing",
      lookFor: "Coverts lying over the bases of the primaries.",
      visibility: "Seen in flight from above.",
    },
    {
      id: "alula",
      name: "Alula",
      group: "Wing",
      lookFor: "A few small feathers at the bend of the wing, on the thumb.",
      visibility: "Seen in flight from above.",
    },
    {
      id: "secondaries",
      name: "Secondaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the inner wing: darker green above on a Rose-ringed, mostly grey below. A Monk Parakeet's flight feathers are dark blue, and a Nanday's trailing flight feathers black.",
    },
    {
      id: "speculum",
      name: "Speculum",
      group: "Wing",
      lookFor:
        "A bright patch on the secondaries. Several amazon parrots have a red or orange one: a Lilac-crowned Amazon's first five secondaries carry a bright red speculum, and a Yellow-crowned Amazon has a red speculum and a red leading edge at the shoulder. A Rose-ringed Parakeet has none, so this area only marks where it would be.",
      visibility: "Often hidden on a perched bird; seen best in flight.",
    },
    {
      id: "tertials",
      name: "Tertials",
      group: "Wing",
      lookFor: "The innermost flight feathers, next to the body, lying over the folded wing. Green on a Rose-ringed.",
    },
    {
      id: "primaries",
      name: "Primaries",
      group: "Wing",
      lookFor:
        "The flight feathers of the hand, forming the long, pointed outer wing; darker green above on a Rose-ringed and mostly grey below. A Monk Parakeet's blue outer wing shows best in flight, and a Blue-crowned's open wing shows blue-brown, chestnut on the outer flight feathers. Amazons have short, rounded wings; the Echo Parakeet's are shorter and rounder than the Rose-ringed's.",
    },
    {
      id: "underwing-coverts",
      name: "Underwing coverts",
      aka: "wing linings",
      group: "Wing",
      lookFor:
        "The feathers lining the underside of the wing, over the bases of the flight feathers: green on a Rose-ringed, against its grey flight feathers. A Green Parakeet's are yellowish green; a Red-masked Parakeet's lesser and median underwing coverts are red.",
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
        "Green on a Rose-ringed. A Monk Parakeet's breast is pale grey with darker scalloping, and an Alexandrine's belly yellow-green.",
    },
    {
      id: "flanks",
      name: "Flanks",
      group: "Underparts",
      lookFor: "Green on a Rose-ringed, mostly hidden under the folded wing on a perched bird.",
    },
    {
      id: "belly",
      name: "Belly",
      group: "Underparts",
      lookFor: "Green on a Rose-ringed. A Nanday Parakeet's thigh feathers are red.",
    },
    {
      id: "undertail-coverts",
      name: "Undertail coverts",
      group: "Underparts",
      lookFor: "The feathers under the base of the tail. Green on a Rose-ringed Parakeet.",
    },
    // Tail
    {
      id: "uppertail-coverts",
      name: "Uppertail coverts",
      group: "Tail",
      lookFor: "The feathers lying over the base of the tail, green on a Rose-ringed.",
      visibility: "Seen in flight from above.",
    },
    {
      id: "tail",
      name: "Tail",
      group: "Tail",
      lookFor:
        "Long, graduated and pointed, as in the other Psittacula parakeets; a male's is longer than a female's. From above the long central feathers are bluish, with yellow tips; from below the tail is yellowish. Compare an Alexandrine's tail, green turning blue and tipped yellow, a Plum-headed's tipped white, a Blue-crowned's green above and red-brown below, and a Nanday's edged blue at the end. Amazons have short, square or rounded tails.",
    },
  ],
};
