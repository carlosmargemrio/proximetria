/* ==================================================
   PROXIMETRIA - FICHA ARQUEOLÓGICA RESPONSIVA
   Versão 1.0.3
   ================================================== */

/* Janela principal */

.detail-dialog {
  width: min(900px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  max-height: min(90vh, 900px);
  max-height: min(90dvh, 900px);
  overflow: hidden;
}

/* Estrutura interna */

.detail-dialog .dialog-shell {
  display: flex;
  flex-direction: column;
  max-height: min(calc(90vh - 2px), 898px);
  max-height: min(calc(90dvh - 2px), 898px);
  min-height: 0;
}

.detail-dialog .dialog-header {
  flex: 0 0 auto;
}

.detail-dialog .dialog-content {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow: hidden;
}

/* Organização dos elementos */

.detail-layout {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 14px;
}

/* Desktop: dados à esquerda e foto à direita */

.detail-top {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
  flex: 0 0 auto;
}

/* Quando não existe fotografia */

.detail-top.no-photo {
  grid-template-columns: minmax(0, 1fr);
}

/* Campos cadastrais */

.detail-dialog .detail-fields {
  display: grid;
  grid-template-columns: minmax(100px, 38%) minmax(0, 1fr);
  gap: 7px 10px;
  font-size: .9rem;
  line-height: 1.4;
  min-width: 0;
  margin: 0;
}

.detail-dialog .detail-fields dd {
  margin: 0;
  overflow-wrap: anywhere;
}

/* Área reservada à fotografia */

.detail-photo {
  margin: 0;
  min-width: 0;
}

.detail-photo-slot {
  display: grid;
  gap: 7px;
  text-align: center;
}

/* Dimensões da fotografia */

.detail-photo-frame {
  display: grid;
  place-items: center;
  height: clamp(140px, 27vh, 235px);
  height: clamp(140px, 27dvh, 235px);
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
}

/* Preserva as proporções originais */

.detail-dialog .detail-photo-frame img {
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
  border: 0;
  margin: 0;
  border-radius: 0;
}

.detail-dialog [hidden] {
  display: none !important;
}

/* Mensagens de carregamento */

.detail-photo-frame small {
  padding: 10px;
  color: var(--muted);
}

/* Link da fotografia original */

.detail-photo-slot a {
  font-size: .8rem;
  color: var(--secondary);
  overflow-wrap: anywhere;
}

/* Síntese arqueológica */

.detail-synthesis {
  display: flex;
  flex-direction: column;
  flex: 0 1 auto;
  min-height: 0;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.detail-synthesis-text {
  flex: 0 1 auto;
  min-height: 0;
  max-height: clamp(100px, 28vh, 300px);
  overflow-y: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  line-height: 1.55;
  padding-right: 6px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

/* ==================================================
   TELAS PEQUENAS OU COM ALTURA REDUZIDA
   Apenas uma área de rolagem
   ================================================== */

@media (max-width: 700px), (max-height: 620px) {

  .detail-dialog .dialog-content {
    overflow: auto;
    overscroll-behavior: contain;
  }

  .detail-layout {
    flex: 0 0 auto;
  }

  .detail-synthesis-text {
    max-height: none;
    overflow: visible;
    padding-right: 0;
  }
}

/* ==================================================
   CELULARES - MODO RETRATO
   ================================================== */

@media (max-width: 700px) {

  .detail-dialog {
    width: calc(100vw - 16px);
    max-width: calc(100vw - 16px);
  }

  .detail-dialog .dialog-content {
    padding: 12px;
  }

  .detail-top {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }

  .detail-dialog .detail-fields {
    grid-template-columns: minmax(95px, 36%) minmax(0, 1fr);
    gap: 6px 9px;
    font-size: .85rem;
  }

  .detail-photo-frame {
    height: clamp(160px, 30vh, 250px);
    height: clamp(160px, 30dvh, 250px);
  }
}
