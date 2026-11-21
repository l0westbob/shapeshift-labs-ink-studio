# To do

## Try TRELLIS.2 as a modelling front end

Local first: [trellis2mlx](https://github.com/lyonsno/trellis2mlx) runs TRELLIS.2 natively on Apple Silicon (MLX, no
PyTorch). It is set up in `~/dev/experiments/trellis2mlx` with a test batch in `~/dev/experiments/trellis-test` (three
tank reference pictures, `run.sh`). Until Meta grants access to its gated DINOv3 encoder, the ungated timm copy runs
in its place (converted by `convert_timm_dinov3.py`). First run done: a 512 preview of the three.js tank in 68 s, now the
TRELLIS.2 entry in the method comparison. Still to do: detail runs (768 cascade), the other two tanks, and a few props
imported into Godot. Pixal3D (via AssetFurnace) is the next candidate: it reportedly keeps flat colours better, but needs full
Xcode.

The rented route below stays the fallback.

For occasional TRELLIS.2 runs, renting is the better deal at current used-GPU prices. Runpod lists an RTX A6000 with
48 GB at 0.69 US$/h, so two hours cost 1.38 US$ for the GPU, plus storage. The RTX 3090 with 24 GB is a little cheaper
at 0.50 US$/h. For the first own run, take the A6000: it leaves more VRAM headroom. Check price and availability when
creating the pod. [Runpod pricing](https://www.runpod.io/pricing) · [TRELLIS.2 prerequisites](https://github.com/microsoft/TRELLIS.2#prerequisites)

To first see whether the assets suit the game, try a few reference images in Microsoft's Hugging Face demo and import
the .glb files into Godot. For single generations without any setup there is also fal: ten runs at 1024 resolution cost
3 US$ in total. Use an own pod for larger batches or custom pipeline settings.
[Microsoft demo](https://huggingface.co/spaces/microsoft/TRELLIS.2) · [fal pricing per generation](https://fal.ai/models/fal-ai/trellis-2)

On a rented pod, download the results at the end and choose Terminate when the pod is no longer needed. With Stop, the
storage it occupies is still billed.
[Runpod billing](https://contact.runpod.io/hc/en-us/articles/57370686866707-Why-You-re-Still-Being-Charged-After-Stopping-Pods-and-Services)
