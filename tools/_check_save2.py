import json, urllib.request, uuid

BASE = "http://127.0.0.1:8000/api/v1"

def get(path):
    return json.load(urllib.request.urlopen(BASE + path))

source = get("/images?limit=1")["items"][0]
data = urllib.request.urlopen(BASE + f"/images/{source['id']}/file").read()

boundary = "----miraforge" + uuid.uuid4().hex
parts = []
def field(name, value):
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())

field("source_image_id", str(source["id"]))
parts.append(
    f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"edited.png\"\r\nContent-Type: image/png\r\n\r\n".encode()
    + data
    + b"\r\n"
)
parts.append(f"--{boundary}--\r\n".encode())
body = b"".join(parts)

req = urllib.request.Request(BASE + "/editor/save", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
saved = json.load(urllib.request.urlopen(req))
print("saved", saved)

detail = get(f"/generations/{saved['generation_id']}")
print("type", detail["generation_type"], "status", detail["status"], "prompt", detail["prompt"])
print("images", [(i["id"], i["width"], i["height"], i["file_size"]) for i in detail["images"]])

listed = get("/generations?media=image&limit=3")
print("media=image total", listed["total"], "top", [(g["id"], g["generation_type"]) for g in listed["items"]][:3])

served = urllib.request.urlopen(BASE + f"/images/{saved['image_id']}/file")
print("file", served.status, served.headers.get("content-type"), len(served.read()))
