with open(".\\scratch\\schematic_text.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split('\n')

for i in range(860, min(len(lines), 920)):
    print(f"{i+1}: {lines[i].strip()}")
