# Fixtures

Small synthetic images with manifest bytes copied from generated assets in
Sanft & Schön. These are parser fixtures, **not valid signed credentials**:
replacing the pixels invalidates their source hashes. No patient/team photos
or production image pixels are included.

- `plain.jpg`, `plain.png`: solid-colour 64×48 images made with Sharp.
- `xmp-legacy.jpg`: solid-colour JPEG with the old `sus:` XMP packet (creator,
  generation date, rights) and the IPTC source-type field.
- `c2pa-openai.png`: OpenAI GPT-4o `caBX` chunk in the synthetic PNG.
- `c2pa-google.jpg`: Google Generative AI APP11 segments in the synthetic JPEG.
- `c2pa-composite.png`: Google image-to-image `caBX` chunk in the synthetic PNG.

Tests validate metadata extraction and preservation, not signature trust.
