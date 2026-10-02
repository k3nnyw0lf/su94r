# Third-party notices

su94r's own code is MIT licensed (see [LICENSE](LICENSE)). It also uses the following.

## Exercise data: exercises-dataset

`src/data/exercises.index.json` and `src/data/steps/*.json` are built by
`scripts/build-exercises.mjs` from https://github.com/hasaneyldrm/exercises-dataset.
The data and instruction text are used under the MIT License:

```
MIT License

Copyright (c) 2026 Hasan Emir Yıldırım

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation and data files (the "Software"),
to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Exercise images: © Gym visual

The exercise thumbnails and animations are © Gym visual — https://gymvisual.com/.
They are **not** included in this repository and are **not** covered by the MIT license.
The app links to them and shows that credit beside each one. Their use is governed by
Gym visual's terms (https://gymvisual.com/content/3-terms-and-conditions-of-use). If you
run your own copy, get your own permission from Gym visual or remove the images.

## npm packages

Runtime and build dependencies are listed in `package.json` and `package-lock.json`, each
under its own license (mostly MIT). `npx license-checker --production` prints the full list.

## Trademarks

FreeStyle Libre and LibreLinkUp are trademarks of Abbott. Dexcom is a trademark of
Dexcom, Inc. Alexa and Echo are trademarks of Amazon. Samsung, Google, Pixel, Fitbit,
Apple and Chrome belong to their owners. They are named only to say what su94r works
with; su94r is not affiliated with or endorsed by any of them.
