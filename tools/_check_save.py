import json, urllib.request

BASE = "http://127.0.0.1:8000/api/v1"

def get(path):
    return json.load(urllib.request.urlopen(BASE + path))

print("health", get("/health")["status"])

# 找一张已有图片作为「原图」
images = get("/images?limit=1")
source = images["items"][0]
print("source", source["id"], source["width"], source["height"])

# 取它的字节
data = urllib.request.urlopen(BASE + f"/images/{source['id']}/file").read()
print("bytes", len(data))
