with open(".\\scratch\\schematic_text.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split('\n')

targets = ["VDDUSB", "VDDUSB1", "VDD5V", "5V_Vout", "AMS1117", "Switch", "SW1", "D1", "D2", "DC_IN"]

for target in targets:
    print(f"\n=== TRACING: {target} ===")
    matches = []
    for i, line in enumerate(lines):
        if target.lower() in line.lower():
            # Print context lines around the match
            start = max(0, i-2)
            end = min(len(lines), i+3)
            context = [f"  {idx+1}: {lines[idx].strip()}" for idx in range(start, end)]
            matches.append("\n".join(context))
            
    print(f"Found {len(matches)} occurrences:")
    for match in matches[:5]: # print first 5 matches
        print(match)
        print("-" * 20)
