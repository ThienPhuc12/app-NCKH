from PIL import Image
import os

os.chdir('d:\\Web Dashboard NCKH\\app\\public')

logo = Image.open('logo.png')
favicon = logo.resize((256, 256), Image.Resampling.LANCZOS)
favicon.save('favicon.ico')

print('✓ favicon.ico created successfully!')
