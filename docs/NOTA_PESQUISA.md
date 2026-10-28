# Nota de Pesquisa e Relato de Uso de IA

**Projeto:** Assistente Geoespacial para Identificação de Áreas Potenciais de Café (Sentinel-2 L2A)  
**Recorte principal do kit:** `S2B_T23KLS_20250816T132502_L2A` — Entorno de Guaxupé/MG (16/08/2025, estação seca, EPSG:32723, 512 × 512 px a 10 m, 2.621,44 ha)

---

## 1. Fontes Primárias Consultadas

1. **Comportamento espectral e fenológico do cafeeiro em sensoriamento remoto orbital (Sul de Minas Gerais):**
   - *Moreira, M. A.; Adami, M.; Rudorff, B. F. T. (2004).* "Análise espectral e temporal da cultura do café em imagens Landsat." *Pesquisa Agropecuária Brasileira (PAB / Embrapa)*, 39(3), 223–231. Complementado por *Bernardes, T. et al. (2012)*, "Monitoring biennial bearing effect on coffee yield using MODIS remote sensing imagery", *Remote Sensing of Environment*, 124, 241–252, e publicações técnicas do Consórcio Pesquisa Café / Embrapa Café (*Volpato et al., 2018*).
   - **Fundamento aplicado:** No Sul de Minas Gerais, o período seco de inverno (julho–agosto, pós-colheita) maximiza o contraste entre o cafeeiro (*Coffea arabica* L., cultura perene que mantém folhagem verde ativa) e as pastagens e culturas anuais de sequeiro (que entram em senescência acentuada). Ao mesmo tempo, diferentemente de fragmentos de Mata Atlântica e reflorestamentos de eucalipto (dossel contínuo e fechado), o plantio comercial de café em renques espaçados (2,5 m a 4,0 m) expõe faixa de solo e palhada na entrelinha e projeta sombra interna, resultando em: (i) índice de vegetação intermediário-alto (`0,50 ≤ NDVI < 0,76`), inferior ao da mata fechada (`NDVI ≥ 0,76`); (ii) reflectância no vermelho (`B04 ≥ 0,035`) superior à da floresta nativa (`B04 ~ 0,02–0,03`) pela contribuição do solo exposto nas entrelinhas; e (iii) brilho médio nas bandas visíveis (`(B02 + B03 + B04)/3 ≤ 0,07`) mais baixo do que o de gramíneas/lavouras anuais irrigadas, que apresentam folhas planas e claras sem sombreamento de entrelinha.

2. **Especificação radiométrica e máscara de cena do Sentinel-2 L2A (ESA / Copernicus):**
   - *European Space Agency (ESA) — Sentinel-2 Products Specification Document (PSD) & Processing Baseline 04.00/05.11 (2022–2025).*
   - **Fundamento aplicado:** A partir do *Processing Baseline 04.00*, os produtos L2A (BOA — *Bottom-of-Atmosphere Reflectance*) introduziram um *offset* radiométrico de `-1000` nos números digitais (`DN uint16`) para preservar ruído escuro sem truncamento:
     `Reflectância = DN × 0,0001 − 0,1` (com `DN = 0` reservado para `NoData`). O pipeline lê `scales` e `offsets` diretamente do cabeçalho do GeoTIFF e aplica a transformação uma única vez. A camada *Scene Classification Layer* (`SCL`, resolução nativa de 20 m) fornece classes categóricas sem transformação radiométrica e é reamostrada por vizinho mais próximo (*nearest neighbor*) para 10 m a fim de mascarar pixels inválidos (classes `0, 1, 2, 3, 8, 9, 10, 11` — sem dados, saturados, sombra topográfica/escura, sombra de nuvem, nuvens e cirrus) e identificar corpos d'água (`SCL = 6` combinado com `NDWI > 0`).

3. **Referência independente de uso e cobertura da terra (Projeto MapBiomas — Coleção 9):**
   - *Projeto MapBiomas (2024).* "Algorithm Theoretical Basis Document (ATBD) — Agriculture / Perennial Crop: Coffee (Class 46), Collection 9." Disponível em `https://brasil.mapbiomas.org`.
   - **Fundamento aplicado:** Recorte do GeoTIFF público `brasil_coverage_2023.tif` (classe `46 = Café`, `21 = Mosaico de usos`, `3 = Formação florestal`, `15 = Pastagem`, `41 = Outras lavouras temporárias`) reprojetado para a grade de 10 m do Sentinel-2 exclusivamente no script de verificação (`scripts/verificar_mapbiomas.py`) para checagem cruzada de coerência espacial.

---

## 2. Duas Alternativas Consideradas e Justificativa da Escolha

- **Alternativa A (Descartada) — Fatiamento simples apenas por NDVI (`NDVI > 0,50`):**
  - *Por que foi descartada:* Em Guaxupé/MG, fragmentos de Mata Atlântica, matas ciliares e talhões de silvicultura ocupam cerca de 25,8% da cena e apresentam `NDVI` elevado (`mediana 0,79`). Um limiar inferior único em NDVI classificaria toda a vegetação arbórea nativa como café. Mesmo um fatiamento simples `0,50 ≤ NDVI < 0,76` sem restrição nas bandas do visível inclui bordas de mata (pixels mistos de transição) e lavouras anuais irrigadas.

- **Alternativa B (Descartada) — Classificador supervisionado (Random Forest / U-Net) treinado nos próprios pixels do MapBiomas 30 m da cena:**
  - *Por que foi descartada:* O kit não possui gabarito de campo. Treinar um modelo supervisionado usando como "verdade" o raster de 30 m do MapBiomas na mesma imagem produziria dois problemas metodológicos graves: (1) na resolução de 30 m do Landsat, grande parte dos cafezais de pequeno e médio porte do Sul de Minas é agregada na classe `21 (Mosaico de usos)`, contaminando os rótulos; e (2) avaliar o modelo na própria cena geraria métricas aparentes de "acurácia" sem lastro em validação de campo — violando a diretriz expressa do desafio de não apresentar acurácia sem evidências.

- **Método Escolhido — Regras físico-agronômicas multiespectrais + filtragem orientada a objetos (GEOBIA simplificado):**
  - *Justificativa:* É transparente, determinístico, rápido (executa em ~1,5 s na CPU em hospedagem gratuita), não depende de treinamento caixa-preta sem rótulos de campo e permite que cada limiar tenha interpretação física defensável (`NDVI ∈ [0,50; 0,76)`, `B04 ≥ 0,035`, `brilho visível ≤ 0,07`, buffer de 1 pixel contra borda de mata, abertura/fechamento morfológico, área mínima `≥ 1,0 ha` e `NDVI médio do polígono ∈ [0,52; 0,74]`).

---

## 3. Imagens Adicionais Obtidas e Condições de Uso dos Dados e Modelos

Pelo script `scripts/baixar_imagem_adicional.py`, consultamos a API STAC pública **Earth Search (Element 84)** (`https://earth-search.aws.element84.com/v1`, coleção `sentinel-2-c1-l2a`, COGs públicos no *AWS Registry of Open Data*) e extraímos duas cenas reais adicionais mantendo o formato exato do kit (`uint16`, 4 bandas de 10 m com `scale = 0,0001` e `offset = -0,1` + `SCL` de 20 m):

1. **`guaxupe_2024.tif` (Outra data / mesma área — comparação multitemporal):**
   - Cena `S2A_T23KLS_20240717T132233_L2A`, adquirida em **17/07/2024 às 13:28:09 UTC** (`0,00%` de nuvens na janela), cobrindo o mesmo recorte de Guaxupé/MG um ano antes.
2. **`tres_pontas_2025.tif` (Outra área cafeeira — mesma estação seca de 2025):**
   - Cena `S2C_T23KMS_20250818T131301_L2A`, adquirida em **18/08/2025 às 13:18:29 UTC** (`0,00%` de nuvens na janela), centrada em **Três Pontas/MG** (`-45,602°; -21,296°`), tradicional polo cafeeiro do Sul de Minas.

**Condições de uso e atribuição:**
- **Dados Sentinel-2:** Abertos e gratuitos sob o *Copernicus Sentinel Data Legal Notice* (Comissão Europeia / ESA). Como os recortes foram espacialmente extraídos e empilhados em 4 bandas, todos os arquivos, telas e imagens exportadas trazem a atribuição obrigatória: *"Contains modified Copernicus Sentinel data (2024–2025)"*.
- **Dados MapBiomas (script de verificação):** Licença pública *Creative Commons CC-BY-SA 4.0*.
- **Modelo de linguagem (Chatbot):** API **Google Gemini** (`gemini-2.5-flash` via Google AI Studio, camada gratuita), com *fallback* determinístico local caso a chave não esteja configurada ou a cota diária seja atingida.

---

## 4. Verificação dos Resultados, Erro Encontrado e Limitações

### Como verificamos os resultados
1. **Verificação geométrica e radiométrica automatizada (`pytest`):** 13 testes automatizados garantem que a conversão `DN × 0,0001 − 0,1` não é aplicada duas vezes, que `DN = 0` vira `NoData`, que o `NDVI` bate com o valor analítico e que a soma da área geodésica dos polígonos (calculada no elipsoide WGS84 via `pyproj.Geod`) coincide com a contagem de pixels × `0,01 ha` dentro de `< 1%`.
2. **Comparação cruzada com o MapBiomas Coleção 9 (`scripts/verificar_mapbiomas.py`):**
   - **Recorte do Kit (`Guaxupé, 16/08/2025`):** O pipeline identificou **70 polígonos potenciais somando 238,92 ha** (`9,12%` da área válida). O cruzamento com o MapBiomas mostra que **53,1% de todos os pixels mapeados como Café pelo MapBiomas (classe 46)** na cena foram recuperados dentro da nossa classe candidata, e que **51,5% da área candidata** cai em Café (`11,2%`) ou Mosaico de usos (`40,3%`, classe onde o MapBiomas 30 m agrupa pequenos talhões de café entremeados a pasto/arborização).
   - **Imagem Adicional 1 (`Três Pontas, 18/08/2025`):** Identificados **54 polígonos somando 1.123,71 ha** (`42,87%` da área válida). Nessa região de cafeicultura contínua, **84,3% da área candidata do aplicativo coincide diretamente com a classe 46 (Café) do MapBiomas** (`91,3%` somando Café + Mosaico de usos), recuperando **59,1%** do café de referência.
   - **Imagem Adicional 2 (`Guaxupé, 17/07/2024`):** Identificados **28 polígonos (70,31 ha)**. A comparação com agosto de 2025 evidenciou que em meados de julho (início do inverno seco) metade dos cafezais ainda apresentava `NDVI ≥ 0,76`, sendo classificada como "vegetação densa" quando se mantêm fixos os limiares calibrados para o auge da seca (agosto).

### Erro real encontrado durante a verificação e como foi corrigido
Na primeira versão do classificador (`0,50 ≤ NDVI < 0,76` e `B04 ≥ 0,035`), a área candidata em Guaxupé era de **347,60 ha (81 polígonos)**. Ao inspecionar o painel visual lado a lado (`RGB | Classificação | MapBiomas`), detectamos **dois erros sistemáticos**:
1. **Efeito de borda em fragmentos florestais:** Pixels de 10 m situados exatamente na fronteira entre mata fechada (`NDVI ~ 0,80`) e pastagem seca (`NDVI ~ 0,32`) resultam em mistura espectral com `NDVI ~ 0,60` e `B04 ~ 0,05`, formando falsos "anéis de café" contornando matas ciliares.
2. **Falso positivo em lavoura anual irrigada/gramínea clara:** Um talhão a sudoeste da cena (visivelmente verde-fluorescente no RGB, mapeado como lavoura temporária pelo MapBiomas) tinha `NDVI = 0,646`, entrando como candidato. Ao inspecionar as bandas individuais, verificamos que sua reflectância no verde (`B03 = 0,052`) e seu brilho médio no visível (`0,067` a `0,085`) eram substancialmente maiores que os dos talhões de café (`brilho visível mediano = 0,048`, escurecidos pelo sombreamento entre linhas).

**Correção implementada:** Adicionamos (i) dilatação morfológica de 1 pixel (`dense_buffer_px = 1`) sobre a máscara de vegetação densa para excluir pixels mistos de transição florestal e (ii) o critério de brilho visível máximo (`(B02 + B03 + B04)/3 ≤ 0,07`). Com isso, o talhão de lavoura anual e as bordas de mata foram eliminados, reduzindo falsos positivos em `108,7 ha` sem perder os cafezais (a recuperação da classe 46 do MapBiomas manteve-se em `53,1%`).

### Limitações do método
1. **Áreas potenciais ≠ café confirmado:** Índices de vegetação e bandas visíveis/NIR em data única não comprovam botanicamente a presença de *Coffea spp.* Nem o sistema nem o chatbot declaram acurácia ou confirmação de campo.
2. **Ausência de bandas SWIR (B11/B12) e Red-Edge (B05–B07):** O recorte contém apenas 4 bandas (B02, B03, B04, B08), o que impede o uso de índices de água foliar/lignina no infravermelho de ondas curtas (como NDMI/NBR), úteis para separar café de capoeiras, citros, pomares ou cana em rebrota.
3. **Sensibilidade sazonal (fenologia):** Como demonstrado no teste com a imagem de `17/07/2024`, a mesma lavoura muda de patamar de NDVI ao longo da estação seca; datas chuvosas ou início de inverno exigem ajuste dos limiares (disponibilizado na interface em *Parâmetros avançados*).
4. **Podas drásticas e lavouras jovens:** Cafezais recém-submetidos a recepa, esqueletamento ou decote, bem como plantios em formação (< 2 anos), têm alta fração de solo exposto (`NDVI < 0,50`) e são omitidos.

---

## 5. Relato de Uso de IA no Desenvolvimento

- **Ferramentas utilizadas:** Assistente de programação baseado em LLM (Claude / Gemini no ambiente de desenvolvimento) para apoio na estruturação dos módulos FastAPI/React, geração de testes `pytest` e revisão da documentação, além da API **Google Gemini (`gemini-2.5-flash`)** integrada ao endpoint `/api/analyses/{id}/chat`.
- **Como as entregas foram validadas:**
  1. **Geoprocessamento auditado contra os dados reais:** Todas as fórmulas (`DN × 0,0001 − 0,1`, `NDVI`, `SAVI`, `GNDVI`, `NDWI`, reprojeção `EPSG:32723 → EPSG:3857 / EPSG:4326` e cálculo de área geodésica WGS84) foram verificadas por scripts determinísticos e 13 testes automatizados (`pytest`) sobre o GeoTIFF real do kit e rasters sintéticos controlados.
  2. **Inspeção visual e estatística:** Os percentis espectrais de cada classe e os mapas gerados foram inspecionados visualmente contra o compósito RGB e cruzados com a Coleção 9 do MapBiomas, o que permitiu identificar e corrigir o erro de borda de mata e de brilho visível descrito na Seção 4.
  3. **Prevenção de alucinação no Chatbot:** O LLM não executa cálculos nem recebe a imagem bruta; ele recebe no *system prompt* o JSON estruturado produzido pelo pipeline Python (`area_total_ha`, `candidatas`, `classes`, `indices`, `poligonos_maiores`, `limitacoes`) sob instrução estrita de citar apenas números do contexto e jamais afirmar confirmação de campo ou acurácia.
