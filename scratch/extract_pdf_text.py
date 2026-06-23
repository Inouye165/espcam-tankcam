import pypdf

reader = pypdf.PdfReader(".\\scratch\\schematic.pdf")
text = reader.pages[0].extract_text()
with open(".\\scratch\\schematic_text.txt", "w", encoding="utf-8") as f:
    f.write(text)
print("Saved text to .\\scratch\\schematic_text.txt")
