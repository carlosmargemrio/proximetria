# ProxiMetria

Aplicação web/PWA para calcular a distância de um ponto aos sítios arqueológicos cadastrados no SICG/IPHAN.

A arquitetura separa o **cliente** (GitHub Pages, sem CORS Anywhere) da **atualização da base** (GitHub Actions + Python). A consulta ao GeoServer é controlada por metadado persistente e ocorre no máximo uma vez a cada 48 horas, salvo execução manual forçada.

Comece por **[LEIA-ME-PRIMEIRO.md](LEIA-ME-PRIMEIRO.md)**.
