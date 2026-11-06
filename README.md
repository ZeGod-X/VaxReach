# VaxReach

VaxReach is a browser-based immunisation follow-up prototype for coordinating vaccination reminders, outreach, and support across health workers, administrators, and families.

## Run the prototype

Open `index.html` in a modern browser. The map uses Leaflet from unpkg, so map features need an internet connection.

## Offline vaccination drafts

Health workers can save vaccination entries while offline. They remain drafts in the current browser and move to the administrator review queue when the connection returns. An administrator can approve and verify the entry, which updates the demo schedule, or request changes for the worker to resubmit.

This prototype keeps all data in browser local storage. The offline queue does not transmit data to a server or sync across devices. Keep using the same browser until a secure backend and sync API are connected.

## Demo data

The app seeds sample records in the browser. Use only the built-in demo data; do not enter real patient information. This prototype has no production backend, and its vaccination schedule is not clinically verified. Confirm schedules and care decisions with an authorised health professional before real-world use.
