#  WhatsApp Selfbot

Conectare prin **QR code afisat direct in terminal**.

## Termux (telefon)

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git
git clone https://github.com/curumatipulan-dev/whatsapp-bot.git
cd whatsapp-bot
npm install --omit=optional
npm start
```

Apare QR-ul in terminal. Pe telefon:
WhatsApp > Setari > Dispozitive conectate > Asociaza un dispozitiv > scanezi QR-ul
(daca botul ruleaza pe acelasi telefon, fa screenshot la QR sau deschide link-ul afisat sub QR pe alt ecran).

Sfat Termux: micsoreaza fontul (pinch-to-zoom) sau roteste telefonul pe orizontala ca QR-ul sa incapa intreg.

## Hosting (bothosting / VPS)

```bash
npm install --omit=optional
node index.js
```

QR-ul apare in consola. Scaneaza-l in max 20 secunde (se regenereaza automat).

## Comenzi utile

- `npm start` - porneste botul
- `npm run reset` - sterge sesiunea (`auth_info`) si cere QR nou

## Ce a fost reparat

- Eliminate patch-urile care rescriau fisiere din `node_modules` (stricau baileys => conexiunea nu mergea niciodata).
- `canvas` mutat in `optionalDependencies` (nu se compileaza pe Termux, bloca `npm install`).
- Bug critic: dupa scanarea QR, WhatsApp trimite codul 515 (restart required). Codul vechi il trata ca "stream error" si stergea `auth_info` => bucla infinita de QR-uri. Acum se reconecteaza normal si sesiunea se pastreaza.
- Baileys actualizat la 6.7.24 (versiunea 6.7.9 era refuzata de serverele WhatsApp).
- QR-ul se afiseaza primul in terminal, link-ul de backup dedesubt.

Nu incarca folderul `auth_info` pe GitHub - contine sesiunea ta WhatsApp.
