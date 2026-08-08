function partagerFormulaire(titre, url) {
  const lien = new URL(url, window.location.href).href;
  if (navigator.share) {
    navigator.share({ title: titre, text: titre, url: lien }).catch(() => {});
    return;
  }
  navigator.clipboard?.writeText(lien).then(() => alert('Lien copié.')).catch(() => prompt('Copiez ce lien :', lien));
}
