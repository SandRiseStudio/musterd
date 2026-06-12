Output docs/assets/flagship.gif

# Width/Height are the GIF's pixel dimensions; FontSize sets how many
# terminal columns/rows fit. The demo paces itself (captions + sleeps),
# so play at 1x and let the script control timing.
Set FontSize 14
Set Width 1060
Set Height 940
Set Padding 20
Set Theme "Dracula"
Set PlaybackSpeed 1.0

Type "node examples/flagship-demo.mjs"
Enter
Sleep 48s
