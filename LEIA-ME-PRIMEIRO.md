# ProxiMetria — pacote GitHub/PWA

Este pacote foi organizado para que a aplicação **não consulte o GeoServer do IPHAN diretamente no navegador**. O navegador recebe arquivos JSON estáticos do mesmo domínio do site; o GeoServer é consultado pelo GitHub Actions, em ambiente de servidor, no máximo uma vez a cada 48 horas.

## O que já está pronto

- interface responsiva para desktop, tablet e celular;
- entrada em graus decimais e UTM;
- leitura de GPS EXIF de fotografias sem envio da imagem;
- geolocalização do aparelho;
- mapa Leaflet/OpenStreetMap, escolha de ponto por clique e filtro opcional por raio;
- cálculo de distância em Web Worker para evitar travamentos da interface;
- paginação de 50 resultados;
- filtro por UF, margem de proximidade e exportação CSV;
- ficha local com síntese e imagem do SICG quando disponíveis;
- PWA com `manifest.webmanifest`, ícones e Service Worker;
- cache da base para reabertura offline após a primeira visita online;
- script Python para consulta WFS paginada;
- fallback para WFS 1.0 em carga única se a paginação WFS 2.0 não funcionar;
- validações para impedir que uma resposta incompleta substitua uma base boa;
- comparação por `id_bem`/`co_iphan` e arquivo `novos_sitios.json`;
- atualização automática com controle persistente de **48 horas reais**;
- publicação pelo GitHub Pages no mesmo workflow.

## 1. Colocar no GitHub

1. Crie um repositório, por exemplo `proximetria`.
2. Extraia este ZIP e envie **todo o conteúdo da pasta**, preservando `.github/workflows/`.
3. Use `main` como branch principal.
4. No repositório, abra **Settings → Pages** e, em **Source**, selecione **GitHub Actions**.
5. Em **Settings → Actions → General → Workflow permissions**, permita **Read and write permissions** se sua configuração do repositório não conceder escrita ao `GITHUB_TOKEN`.
6. Abra a aba **Actions**, selecione **Atualizar base SICG e publicar**, clique em **Run workflow** e mantenha `force_update = true` na primeira execução.

A primeira execução consulta a camada `SICG:sitios`, gera os arquivos compactos em `dados/`, registra a atualização no próprio repositório e publica a PWA.

## 2. Regra dos dois dias

O cron acorda a cada seis horas (`23 */6 * * *`), mas isso **não significa seis consultas ao GeoServer por dia**. Antes de qualquer acesso ao servidor do IPHAN, `scripts/atualizar_proximetria.py` lê `dados/sitios_brasil.meta.json`.

Se ainda não transcorreram 48 horas desde `ultima_consulta_utc`, a execução termina com `SKIP` e o GeoServer não é consultado. O cron mais frequente serve apenas para que atrasos do GitHub Actions não empurrem a atualização por um dia inteiro.

A opção `--force` existe apenas para execução manual intencional.

## 3. Usar sua base `resultado_imagens8.json` como carga inicial

O arquivo bruto não precisa ficar no Git. Coloque-o temporariamente na pasta raiz e execute:

```bash
python scripts/importar_resultado.py resultado_imagens8.json
python scripts/validar_dados.py
```

O importador gera:

- `dados/sitios_brasil.json` — índice enxuto usado no cálculo;
- `dados/sitios_brasil_detalhes.json` — síntese, imagem e campos complementares;
- `dados/sitios_brasil.meta.json` — estatísticas, datas e hashes;
- `dados/novos_sitios.json` — apenas acréscimos em relação à base anterior.

`resultado_imagens8.json` está no `.gitignore`, evitando subir o arquivo bruto por acidente. Após a importação, faça commit apenas dos arquivos em `dados/`.

O importador deixa `ultima_consulta_utc` vazia. Assim, mesmo depois de semear a base local, o primeiro workflow pode consultar imediatamente o GeoServer e confrontar a versão mais recente.

## 4. Como a atualização protege a base

Antes de substituir os arquivos publicados, o script exige:

- no mínimo 1.000 registros na primeira carga remota;
- pelo menos 90% dos registros com coordenadas válidas;
- se já existir uma base anterior, a nova não pode apresentar queda superior a 10% no número total;
- deduplicação por `id_bem`, depois `co_iphan`, com chaves auxiliares apenas quando necessário.

Se alguma regra falhar, o script encerra com erro **antes de gravar os novos JSONs**. O GitHub Pages continua servindo a versão anterior.

## 5. Estrutura do repositório

```text
proximetria/
├── index.html
├── config.json
├── manifest.webmanifest
├── sw.js
├── offline.html
├── assets/
│   ├── css/app.css
│   ├── js/app.js
│   ├── js/distance-worker.js
│   └── icons/
├── dados/
│   ├── sitios_brasil.json
│   ├── sitios_brasil_detalhes.json
│   ├── sitios_brasil.meta.json
│   └── novos_sitios.json
├── scripts/
│   ├── proximetria_data.py
│   ├── atualizar_proximetria.py
│   ├── importar_resultado.py
│   └── validar_dados.py
├── tests/
├── requirements.txt
└── .github/workflows/atualizar-e-publicar.yml
```

## 6. Funcionamento como pseudo-app/PWA

A aplicação pode ser instalada pelo navegador quando servida por HTTPS (o GitHub Pages fornece HTTPS). O manifesto define nome, ícones e modo `standalone`; o Service Worker mantém o núcleo da aplicação e guarda a base JSON em cache depois do primeiro carregamento.

O mapa usa tiles externos. Em modo offline, a consulta aos sítios pode continuar funcionando se a base já tiver sido armazenada, mas o fundo cartográfico só estará disponível para tiles que o dispositivo tenha visitado e mantido em cache. Isso evita tentar armazenar previamente mapas de todo o Brasil.

No Android/Chromium, o botão **Instalar app** aparece quando o navegador disponibiliza o evento de instalação. Em navegadores que não expõem esse evento, ainda é possível usar a opção nativa de adicionar o site à tela inicial, quando disponível.

## 7. Campos de coordenadas

Exemplos aceitos:

```text
-8.784657, -42.489848
23K 797000 7995000
24L 398152 8971469
```

A conversão UTM usa WGS84. Como os valores brasileiros são frequentemente informados apenas como zona + E/N, a ausência de hemisfério é interpretada como Sul. Sufixos de banda como `K`, `L` e `M` também são entendidos como hemisfério Sul.

## 8. Alterações simples

As opções principais ficam em `config.json`. fiquem avontade para modificar o número de linhas por página, URLs dos arquivos, centro inicial do mapa e URL-base das fichas do SICG sem mexer no restante do JavaScript.

Para alterar cores e disposição visual, edite `assets/css/app.css`.

## 9. Fontes e documentação técnica

- IPHAN/SICG — camada WFS `SICG:sitios`: `https://portal.iphan.gov.br/geoserver/SICG/ows`
- GitHub Pages: `https://docs.github.com/pages`
- GitHub Actions — eventos agendados: `https://docs.github.com/actions/using-workflows/events-that-trigger-workflows#schedule`
- MDN — Progressive Web Apps: `https://developer.mozilla.org/docs/Web/Progressive_web_apps`
- Leaflet: `https://leafletjs.com/`
- PROJ/proj4js: `https://proj4js.org/`

### Observação sobre workflows agendados

O GitHub informa que workflows `schedule` podem sofrer atraso em períodos de carga e que, em repositórios públicos sem atividade por 60 dias, workflows agendados podem ser desabilitados. Por isso o arquivo usa minuto 23, em vez do início da hora, e mantém também a execução manual (`workflow_dispatch`).
