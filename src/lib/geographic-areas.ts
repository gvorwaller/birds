/**
 * Stable geographic drilldown for the loaded-data hub.
 *
 * Countries are grouped by physical location rather than political ownership
 * so overseas territories appear where a birder would look for them. Keep the
 * lists explicit: boundary cases (Russia, Cyprus, Atlantic islands) should be
 * product decisions, not accidental longitude cutoffs.
 */
export const GEOGRAPHIC_AREAS = [
  {
    id: "north-america",
    name: "North America",
    countryCodes: ["BM", "CA", "CP", "GL", "MX", "PM", "US"],
  },
  {
    id: "central-america-caribbean",
    name: "Central America & Caribbean",
    countryCodes: [
      "AG",
      "AI",
      "AW",
      "BB",
      "BL",
      "BQ",
      "BS",
      "BZ",
      "CR",
      "CU",
      "CW",
      "DM",
      "DO",
      "GD",
      "GP",
      "GT",
      "HN",
      "HT",
      "JM",
      "KN",
      "KY",
      "LC",
      "MF",
      "MQ",
      "MS",
      "NI",
      "PA",
      "PR",
      "SV",
      "SX",
      "TC",
      "TT",
      "VC",
      "VG",
      "VI",
    ],
  },
  {
    id: "south-america",
    name: "South America",
    countryCodes: [
      "AR",
      "BO",
      "BR",
      "CL",
      "CO",
      "EC",
      "FK",
      "GF",
      "GS",
      "GY",
      "PE",
      "PY",
      "SR",
      "UY",
      "VE",
    ],
  },
  {
    id: "europe",
    name: "Europe",
    countryCodes: [
      "AD",
      "AL",
      "AT",
      "BA",
      "BE",
      "BG",
      "BY",
      "CH",
      "CZ",
      "DE",
      "DK",
      "EE",
      "ES",
      "FI",
      "FO",
      "FR",
      "GB",
      "GG",
      "GI",
      "GR",
      "HR",
      "HU",
      "IE",
      "IM",
      "IS",
      "IT",
      "JE",
      "LI",
      "LT",
      "LU",
      "LV",
      "MC",
      "MD",
      "ME",
      "MK",
      "MT",
      "NL",
      "NO",
      "PL",
      "PT",
      "RO",
      "RS",
      "RU",
      "SE",
      "SI",
      "SJ",
      "SK",
      "SM",
      "UA",
      "VA",
      "XK",
    ],
  },
  {
    id: "africa",
    name: "Africa",
    countryCodes: [
      "AO",
      "BF",
      "BI",
      "BJ",
      "BW",
      "CD",
      "CF",
      "CG",
      "CI",
      "CM",
      "CV",
      "DJ",
      "DZ",
      "EG",
      "EH",
      "ER",
      "ET",
      "GA",
      "GH",
      "GM",
      "GN",
      "GQ",
      "GW",
      "KE",
      "KM",
      "LR",
      "LS",
      "LY",
      "MA",
      "MG",
      "ML",
      "MR",
      "MU",
      "MW",
      "MZ",
      "NA",
      "NE",
      "NG",
      "RE",
      "RW",
      "SC",
      "SD",
      "SH",
      "SL",
      "SN",
      "SO",
      "SS",
      "ST",
      "SZ",
      "TD",
      "TG",
      "TN",
      "TZ",
      "UG",
      "YT",
      "ZA",
      "ZM",
      "ZW",
    ],
  },
  {
    id: "asia",
    name: "Asia",
    countryCodes: [
      "AE",
      "AF",
      "AM",
      "AZ",
      "BD",
      "BH",
      "BN",
      "BT",
      "CN",
      "CY",
      "GE",
      "HK",
      "ID",
      "IL",
      "IN",
      "IO",
      "IQ",
      "IR",
      "JO",
      "JP",
      "KG",
      "KH",
      "KP",
      "KR",
      "KW",
      "KZ",
      "LA",
      "LB",
      "LK",
      "MM",
      "MN",
      "MO",
      "MV",
      "MY",
      "NP",
      "OM",
      "PH",
      "PK",
      "PS",
      "QA",
      "SA",
      "SG",
      "SY",
      "TH",
      "TJ",
      "TL",
      "TM",
      "TR",
      "TW",
      "UZ",
      "VN",
      "YE",
    ],
  },
  {
    id: "oceania",
    name: "Oceania",
    countryCodes: [
      "AC",
      "AS",
      "AU",
      "CC",
      "CK",
      "CS",
      "CX",
      "FJ",
      "FM",
      "GU",
      "KI",
      "MH",
      "MP",
      "NC",
      "NF",
      "NR",
      "NU",
      "NZ",
      "PF",
      "PG",
      "PN",
      "PW",
      "SB",
      "TK",
      "TO",
      "TV",
      "UM",
      "VU",
      "WF",
      "WS",
    ],
  },
  {
    id: "antarctica",
    name: "Antarctica",
    countryCodes: ["AQ", "BV", "HM", "TF"],
  },
] as const;

export type GeographicAreaId =
  | (typeof GEOGRAPHIC_AREAS)[number]["id"]
  | "other";

const AREA_BY_COUNTRY = new Map<string, (typeof GEOGRAPHIC_AREAS)[number]>();
for (const area of GEOGRAPHIC_AREAS) {
  for (const code of area.countryCodes) AREA_BY_COUNTRY.set(code, area);
}

export function geographicAreaForCountry(code: string): GeographicAreaId {
  return AREA_BY_COUNTRY.get(code)?.id ?? "other";
}

export interface GeographicCountry {
  countryCode: string;
  countryName: string;
}

export interface GeographicAreaGroup<T extends GeographicCountry> {
  id: GeographicAreaId;
  name: string;
  countries: T[];
}

/** Group and alphabetize loaded countries without ever dropping an unknown code. */
export function groupCountriesByGeographicArea<T extends GeographicCountry>(
  countries: readonly T[],
): GeographicAreaGroup<T>[] {
  const grouped = new Map<GeographicAreaId, T[]>();
  for (const country of countries) {
    const id = geographicAreaForCountry(country.countryCode);
    const list = grouped.get(id) ?? [];
    list.push(country);
    grouped.set(id, list);
  }

  const out: GeographicAreaGroup<T>[] = [];
  for (const area of GEOGRAPHIC_AREAS) {
    const list = grouped.get(area.id);
    if (list?.length) {
      out.push({
        id: area.id,
        name: area.name,
        countries: list.sort((a, b) =>
          a.countryName.localeCompare(b.countryName),
        ),
      });
    }
  }
  const other = grouped.get("other");
  if (other?.length) {
    out.push({
      id: "other",
      name: "Other",
      countries: other.sort((a, b) =>
        a.countryName.localeCompare(b.countryName),
      ),
    });
  }
  return out;
}
