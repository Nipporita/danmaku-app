from PIL import Image
import pandas as pd
import glob


data = pd.read_excel("16_all_data.xlsx")
input_folder = r"F:\幻想指南\16\人物卡\人物卡正面\人物卡图片"
all_images = glob.glob(f"{input_folder}/*.png")
output_folder = "./image"

for index, row in data.iterrows():
    # 缩放到高为500像素
    for img_path in all_images:
        if f"数据组“{index + 1}”_export.png" in img_path:
            img = Image.open(img_path)
            w, h = img.size
            new_h = 500
            new_w = int(w * (new_h / h))
            img = img.resize((new_w, new_h), Image.ANTIALIAS)
            img.save(f"{output_folder}/{row['name']}.png")
            print(f"Saved image for {row['name']}")
            break