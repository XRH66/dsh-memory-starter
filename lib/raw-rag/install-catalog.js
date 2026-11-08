// Reviewed upstream artifacts, 2026-11-05. Do not replace revisions with main
// or latest: installation and resumption must refer to the same bytes.
const hf = (repo, revision, file, size, sha256) => ({ file, size, sha256,
  url: `https://huggingface.co/${repo}/resolve/${revision}/${file}` });
const bgeRepo='Qdrant/bge-small-zh-v1.5', bgeRevision='46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59';
export const PYTHON_PACKAGES=Object.freeze(['numpy==2.5.4','tokenizers==0.23.3','onnxruntime==1.31.0']);
export const FASTEMBED_PACKAGE='fastembed==0.9.0';
export const INSTALL_CATALOG=Object.freeze({
  'BAAI/bge-small-zh-v1.5': {
    key:'bge-zh-v15',repo:bgeRepo,revision:bgeRevision,origin:'Qdrant 的 BGE ONNX 转换',
    homepage:'https://huggingface.co/Qdrant/bge-small-zh-v1.5',
    artifacts:[
      hf(bgeRepo,bgeRevision,'model_optimized.onnx',94781076,'1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38'),
      hf(bgeRepo,bgeRevision,'config.json',739,'9088751d39abbf86ec3d19ffca92ad62ad19075f7e59712e6c71217fa125d1d3'),
      hf(bgeRepo,bgeRevision,'ort_config.json',1234,'97e78d1d21c2eb719e865b018f17915df6a12ed987446eb7f3f3a783a5afb1e1'),
      hf(bgeRepo,bgeRevision,'special_tokens_map.json',125,'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3'),
      hf(bgeRepo,bgeRevision,'tokenizer.json',439125,'48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26'),
      hf(bgeRepo,bgeRevision,'tokenizer_config.json',367,'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a'),
      hf(bgeRepo,bgeRevision,'vocab.txt',109540,'45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c'),
    ],
  },
  'Qwen/Qwen3-Embedding-0.6B': {
    key:'qwen-06b-int8',repo:'onnx-community/Qwen3-Embedding-0.6B-ONNX',revision:'c25a394dd583836952667c12f008335071b3f43d',origin:'ONNX Community 转换，非 Qwen 官方 ONNX 文件',
    homepage:'https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX',
    artifacts:[
      hf('onnx-community/Qwen3-Embedding-0.6B-ONNX','c25a394dd583836952667c12f008335071b3f43d','onnx/model_quantized.onnx',613527631,'87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f'),
      hf('onnx-community/Qwen3-Embedding-0.6B-ONNX','c25a394dd583836952667c12f008335071b3f43d','tokenizer.json',11423705,'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a'),
    ],
  },
  'Qwen/Qwen3-Embedding-4B': {
    key:'qwen-4b-q4km',repo:'Qwen/Qwen3-Embedding-4B-GGUF',revision:'f4602530db1d980e16da9d7d3a70294cf5c190be',origin:'Qwen 官方 GGUF · Q4_K_M',
    homepage:'https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF',
    artifacts:[hf('Qwen/Qwen3-Embedding-4B-GGUF','f4602530db1d980e16da9d7d3a70294cf5c190be','Qwen3-Embedding-4B-Q4_K_M.gguf',2496703776,'2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b')],
  },
  'Qwen/Qwen3-Embedding-8B': {
    key:'qwen-8b-q4km',repo:'Qwen/Qwen3-Embedding-8B-GGUF',revision:'69d0e58a13e463cd99a9b83e3f5fee7c10265fab',origin:'Qwen 官方 GGUF · Q4_K_M',
    homepage:'https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF',
    artifacts:[hf('Qwen/Qwen3-Embedding-8B-GGUF','69d0e58a13e463cd99a9b83e3f5fee7c10265fab','Qwen3-Embedding-8B-Q4_K_M.gguf',4676804928,'3fcd3febec8b3fd64435204db75bf0dd73b91e8d0661e0331acfe7e7c3120b85')],
  },
});
const llama=(file,size,sha256)=>({file,size,sha256,url:'https://github.com/ggml-org/llama.cpp/releases/download/b12110/'+file});
export const LLAMA_RUNTIME=Object.freeze({
  revision:'b12110',homepage:'https://github.com/ggml-org/llama.cpp/releases/tag/b12110',
  cpu:[llama('llama-b12110-bin-win-cpu-x64.zip',24708445,'98901e327c252875accaf2d1bf364e10e868843b0b63468baad1aa945cdc5da2')],
  cuda:[llama('llama-b12110-bin-win-cuda-12.4-x64.zip',287014657,'1ce755bc3a061889234048f88e33328e17971eaad73c4666cfeb26026b317fee'),
    llama('cudart-llama-bin-win-cuda-12.4-x64.zip',391443627,'8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6')],
});
