# Open Data Graveyard

<!-- coolcode:guide -->
Search a removed listing and follow its original URL, archive search and related-current-release links. A catalogue deletion supplies a timestamp and identifier, but does not explain the removal or prove the underlying data was destroyed.
<!-- /coolcode:guide -->

A browser-based explorer of entries Canada removed from the Open Government Portal, part of [CoolCode](https://coolcode.ca/opendatagraveyard/). Search English and French titles, organizations, dates and record IDs. Filter the timeline by year or month. Each entry offers links to check its original URL, archived captures and related current releases.

The source [Open Government Analytics](https://open.canada.ca/data/en/dataset/2916fad5-ebcc-4c86-b0f3-4f619b29f412) includes a bilingual [deletion CSV](https://open.canada.ca/data/dataset/2916fad5-ebcc-4c86-b0f3-4f619b29f412/resource/d22d2aca-155b-4978-b5c1-1d39837e1993/download/deleted.csv). It records the title, organization, ID and deletion timestamp. It does not provide removal reasons, guarantee an archived copy, or establish that the original data was destroyed. Links to look for related listings are research starting points.

Contains information licensed under the [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada), published by the Treasury Board of Canada Secretariat.

## Build

```sh
python3 scripts/build.py
python3 -m http.server 8080 --directory dist
```

Use Python 3.10+ and a current browser. An already downloaded export can be used with `--input /path/to/deleted.csv`. A dedicated output directory can be set with `--output`.

GitHub Actions builds from the official source on a daily schedule and via **Run workflow**. It publishes the static output to Pages following a successful build. The site distinguishes the publisher's export date, the build date and the most recent recorded deletion. Browsing and filtering use a client-side worker with a compressed index.
