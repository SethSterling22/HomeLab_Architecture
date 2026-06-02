# Guía: GPU Passthrough en Proxmox para Nitro

Esta guía configura el passthrough de la GPU de Nitro hacia la VM `nitro-ollama` para que los modelos AI tengan acceso directo al hardware.

---

## Requisitos

- CPU Intel con VT-d activado en BIOS (o AMD con AMD-Vi)
- Proxmox VE 8.x
- GPU compatible con IOMMU (la mayoría de NVIDIA/AMD modernas)

---

## Paso 1 — Habilitar IOMMU en GRUB

```bash
# En Nitro como root:
nano /etc/default/grub
```

Modificar la línea:
```
GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt"
```
Para AMD usar `amd_iommu=on` en lugar de `intel_iommu=on`.

```bash
update-grub
```

## Paso 2 — Cargar módulos VFIO

```bash
echo -e "vfio\nvfio_iommu_type1\nvfio_pci\nvfio_virqfd" >> /etc/modules
update-initramfs -u -k all
reboot
```

## Paso 3 — Verificar IOMMU activo

```bash
dmesg | grep -e DMAR -e IOMMU
# Debe mostrar: IOMMU enabled
```

## Paso 4 — Identificar la GPU

```bash
lspci | grep -i nvidia
# Ejemplo output:
# 01:00.0 VGA compatible controller: NVIDIA Corporation ...
# 01:00.1 Audio device: NVIDIA Corporation ...
```

Anota el ID (`01:00` en el ejemplo).

## Paso 5 — Agregar GPU a la VM via Proxmox UI

En la interfaz de Proxmox:
1. Seleccionar VM `nitro-ollama` (ID 102)
2. Hardware → Add → PCI Device
3. Seleccionar la GPU (`0000:01:00.0`)
4. Marcar: **All Functions**, **Primary GPU** (si quieres consola), **PCI-Express**
5. Click Add → Start VM

O via CLI:
```bash
qm set 102 --hostpci0 0000:01:00,pcie=1,x-vga=0
```

## Paso 6 — Instalar drivers NVIDIA en la VM

```bash
# Dentro de nitro-ollama VM:
apt update && apt install -y linux-headers-$(uname -r)
apt install -y nvidia-driver firmware-misc-nonfree

# Verificar
nvidia-smi
```

## Paso 7 — Instalar NVIDIA Container Toolkit (para Docker/k3s)

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

apt update && apt install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=containerd
systemctl restart containerd
```

## Verificación final

```bash
# Dentro de la VM nitro-ollama:
nvidia-smi
# debe mostrar la GPU con memoria VRAM disponible

# Probar Ollama con GPU:
ollama run llama3:8b "hola"
# en nvidia-smi debe aparecer el proceso con memoria GPU ocupada
```

---

## Troubleshooting

| Problema | Solución |
|----------|----------|
| `dmesg` no muestra IOMMU | Verificar BIOS VT-d / AMD-Vi habilitado |
| VM no arranca con GPU | Quitar `x-vga=1`, usar solo `x-vga=0` |
| `nvidia-smi` no encuentra GPU | Reinstalar drivers; verificar que vfio no captura el device |
| Ollama no usa GPU | Verificar `nvidia-ctk runtime configure` y reiniciar containerd |
