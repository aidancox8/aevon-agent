# Skyline demo

Text comes in, gets qualified, drafted, offered a calendar slot, confirmed, handed off.

    node demo/skyline-demo.js --text "just got orders to JBLM, need a 3br off base" --from "Marcus Ellison <+1 253-555-0142>"

Flags: `--yes` skips the confirm prompt for a dry rehearsal. Without `--text`, stdin is read.

Honesty note: GoHighLevel is never called. Every "Would POST" block is a payload printed
to the screen, not a real request. There is no GHL account behind this.
