import pandas as pd
import json

data = pd.read_excel('SMWW.xlsx')
output = {}
for index, row in data.iterrows():
    if row['采用'] == 0:
        continue
    output[row['name']] = row[[1,2,3,4,5]].dropna().tolist()

with open('SMWW.json', 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=4)