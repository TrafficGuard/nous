[Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) is a chunk augmentation technique that uses an LLM to enhance each chunk.

![](https://files.readme.io/d155bd890d71de25c1fd1d6a1b1f4a662a948764565ce5f9fdfef8ac016185b8-image.png)

Here's an overview of how it works. 👇

1.  For every chunk - prepend an explanatory context snippet that situates the chunk within the rest of the document. -> Get a small cost effective LLM to do this.
2.  Hybrid Search: Embed the chunk using both sparse (keyword) and dense(semantic) embeddings.
3.  Perform rank fusion using an algorithm like Reciprocal Rank Fusion(RRF).
4.  Retrieve top 150 chunks and pass those to a Reranker to obtain top 20 chunks.
5.  Pass top 20 chunks to LLM to generate an answer.

Below we implement each step in this process using Open Source models.

To breakdown the concept further we break down the process into a one-time indexing step and a query time step.

**Data Ingestion Phase:**

![](https://files.readme.io/ebc155df774f0869538be3912d7a8b4273b16a7e982da0436b6741142d76de55-image.png)

1.  Data processing and chunking
2.  Context generation using a quantized Llama 3.2 3B Model
3.  Vector Embedding and Index Generation
4.  BM25 Keyword Index Generation

**At Query Time:**

![](https://files.readme.io/1b4c444b27e8051a9d52c6ae93d1d41da131116a7d954337204f553e3c8ee67a-image.png)

1.  Perform retrieval using both indices and combine them using RRF
2.  Reranker to improve retrieval quality
3.  Generation with Llama3.1 405B

    pip install together # To access open source LLMs
    pip install --upgrade tiktoken # To count total token counts
    pip install beautifulsoup4 # To scrape documents to RAG over
    pip install bm25s # To implement out key-word BM25 search


![](https://files.readme.io/8fcfe9bad4b50d51016168a52b38b74d13e2e53c2110e99fa157ca5dceaa413a-image.png)

We will RAG over Paul Grahams latest essay titled [Founder Mode](https://paulgraham.com/foundermode.html) .

    # Let's download the essay from Paul Graham's website
    
    import requests
    from bs4 import BeautifulSoup
    
    def scrape_pg_essay():
    
        url = 'https://paulgraham.com/foundermode.html'
    
        try:
            # Send GET request to the URL
            response = requests.get(url)
            response.raise_for_status()  # Raise an error for bad status codes
    
            # Parse the HTML content
            soup = BeautifulSoup(response.text, 'html.parser')
    
            # Paul Graham's essays typically have the main content in a font tag
            # You might need to adjust this selector based on the actual HTML structure
            content = soup.find('font')
    
            if content:
                # Extract and clean the text
                text = content.get_text()
                # Remove extra whitespace and normalize line breaks
                text = ' '.join(text.split())
                return text
            else:
                return "Could not find the main content of the essay."
    
        except requests.RequestException as e:
            return f"Error fetching the webpage: {e}"
    
    # Scrape the essay
    pg_essay = scrape_pg_essay()


This will give us the essay, we still need to chunk the essay, so lets implement a function and use it:

    # We can get away with naive fixed sized chunking as the context generation will add meaning to these chunks
    
    def create_chunks(document, chunk_size=300, overlap=50):
        return [document[i : i + chunk_size] for i in range(0, len(document), chunk_size - overlap)]
         
    
    chunks = create_chunks(pg_essay, chunk_size=250, overlap=30)
    
    for i, chunk in enumerate(chunks):
        print(f"Chunk {i + 1}: {chunk}")


We get the following chunked content:

    Chunk 1: September 2024At a YC event last week Brian Chesky gave a talk that everyone who was there will remember. Most founders I talked to afterward said it was the best they'd ever heard. Ron Conway, for the first time in his life, forgot to take notes. I'
    Chunk 2: life, forgot to take notes. I'm not going to try to reproduce it here. Instead I want to talk about a question it raised.The theme of Brian's talk was that the conventional wisdom about how to run larger companies is mistaken. As Airbnb grew, well-me
    ...


This part contains the main intuition behind `Contextual Retrieval`. We will make an LLM call for each chunk to add much needed relevant context to the chunk. In order to do this we pass in the ENTIRE document per LLM call.

It may seem that passing in the entire document per chunk and making an LLM call per chunk is quite inefficient, this is true and there very well might be more efficient techniques to accomplish the same end goal. But in keeping with implementing the current technique at hand lets do it.

Additionally using quantized small 1-3B models (here we will use Llama 3.2 3B) along with prompt caching does make this more feasible.

Prompt caching allows key and value matrices corresponding to the document to be cached for future LLM calls.

We will use the following prompt to generate context for each chunk:

    # We want to generate a snippet explaining the relevance/importance of the chunk with
    # full document in mind.
    
    CONTEXTUAL_RAG_PROMPT = """
    Given the document below, we want to explain what the chunk captures in the document.
    
    {WHOLE_DOCUMENT}
    
    Here is the chunk we want to explain:
    
    {CHUNK_CONTENT}
    
    Answer ONLY with a succinct explaination of the meaning of the chunk in the context of the whole document above.
    """


Now we can prep each chunk into these prompt template and generate the context:

    from typing import List
    import together, os
    from together import Together
    
    # Paste in your Together AI API Key or load it
    TOGETHER_API_KEY = os.environ.get("TOGETHER_API_KEY")
    
    client = Together(api_key = TOGETHER_API_KEY)
    
    # First we will just generate the prompts and examine them
    
    def generate_prompts(document : str, chunks : List[str]) -> List[str]:
      prompts = []
      for chunk in chunks:
        prompt = CONTEXTUAL_RAG_PROMPT.format(WHOLE_DOCUMENT=document, CHUNK_CONTENT=chunk)
        prompts.append(prompt)
      return prompts
    
    prompts = generate_prompts(pg_essay, chunks)
    
    def generate_context(prompt: str):
        """
        Generates a contextual response based on the given prompt using the specified language model.
        Args:
            prompt (str): The input prompt to generate a response for.
        Returns:
            str: The generated response content from the language model.
        """
        response = client.chat.completions.create(
            model="meta-llama/Llama-3.2-3B-Instruct-Turbo",
            messages=[{"role": "user", "content": prompt}],
            temperature=1
        )
        return response.choices[0].message.content


We can now use the functions above to generate context for each chunk and append it to the chunk itself:

    # Let's generate the entire list of contextual chunks and concatenate to the original chunk
    
    contextual_chunks = [generate_context(prompts[i])+' '+chunks[i] for i in range(len(chunks))]


Now we can embed each chunk into a vector index.

We will now use `bge-large-en-v1.5` to embed the augmented chunks above into a vector index.

    from typing import List
    import together
    import numpy as np
    
    def generate_embeddings(input_texts: List[str], model_api_string: str) -> List[List[float]]:
        """Generate embeddings from Together python library.
    
        Args:
            input_texts: a list of string input texts.
            model_api_string: str. An API string for a specific embedding model of your choice.
    
        Returns:
            embeddings_list: a list of embeddings. Each element corresponds to the each input text.
        """
        outputs = client.embeddings.create(
            input=input_texts,
            model=model_api_string,
        )
        return [x.embedding for x in outputs.data]
      
    contextual_embeddings = generate_embeddings(contextual_chunks, "BAAI/bge-large-en-v1.5")


Next we need to write a function that can retrieve the top matching chunks from this index given a query:

    def vector_retrieval(query: str, top_k: int = 5, vector_index: np.ndarray = None) -> List[int]:
        """
        Retrieve the top-k most similar items from an index based on a query.
        Args:
            query (str): The query string to search for.
            top_k (int, optional): The number of top similar items to retrieve. Defaults to 5.
            index (np.ndarray, optional): The index array containing embeddings to search against. Defaults to None.
        Returns:
            List[int]: A list of indices corresponding to the top-k most similar items in the index.
        """
    
        query_embedding = generate_embeddings([query], 'BAAI/bge-large-en-v1.5')[0]
        similarity_scores = cosine_similarity([query_embedding], vector_index)
    
        return list(np.argsort(-similarity_scores)[0][:top_k])
      
    vector_retrieval(query = "What are 'skip-level' meetings?",
                     top_k = 5, 
                     vector_index = contextual_embeddings)


We now have a way to retrieve from the vector index given a query.

Lets build a keyword index that allows us to use BM25 to perform lexical search based on the words present in the query and the contextual chunks. For this we will use the `bm25s` python library:

    import bm25s
    
    # Create the BM25 model and index the corpus
    retriever = bm25s.BM25(corpus=contextual_chunks)
    retriever.index(bm25s.tokenize(contextual_chunks))


Which can be queried as follows:

    # Query the corpus and get top-k results
    query = "What are 'skip-level' meetings?"
    results, scores = retriever.retrieve(bm25s.tokenize(query), k=5,)


Similar to the function above which produces vector results from the vector index we can write a function that produces keyword search results from the BM25 index:

    def bm25_retrieval(query: str, k : int, bm25_index) -> List[int]:
        """
        Retrieve the top-k document indices based on the BM25 algorithm for a given query.
        Args:
            query (str): The search query string.
            k (int): The number of top documents to retrieve.
            bm25_index: The BM25 index object used for retrieval.
        Returns:
            List[int]: A list of indices of the top-k documents that match the query.
        """
    
        results, scores = bm25_index.retrieve(bm25s.tokenize(query), k=k)
    
        return [contextual_chunks.index(doc) for doc in results[0]]


Once a user submits a query we are going to use both functions above to perform Vector and BM25 retrieval and then fuse the ranks using the RRF algorithm implemented below.

    # Example ranked lists from different sources
    vector_top_k = vector_retrieval(query = "What are 'skip-level' meetings?", top_k = 5, vector_index = contextual_embeddings)
    bm25_top_k = bm25_retrieval(query = "What are 'skip-level' meetings?", k = 5, bm25_index = retriever)


The Reciprocal Rank Fusion algorithm takes two ranked list of objects and combines them:

    from collections import defaultdict
    
    def reciprocal_rank_fusion(*list_of_list_ranks_system, K=60):
        """
        Fuse rank from multiple IR systems using Reciprocal Rank Fusion.
    
        Args:
        * list_of_list_ranks_system: Ranked results from different IR system.
        K (int): A constant used in the RRF formula (default is 60).
    
        Returns:
        Tuple of list of sorted documents by score and sorted documents
        """
        # Dictionary to store RRF mapping
        rrf_map = defaultdict(float)
    
        # Calculate RRF score for each result in each list
        for rank_list in list_of_list_ranks_system:
            for rank, item in enumerate(rank_list, 1):
                rrf_map[item] += 1 / (rank + K)
    
        # Sort items based on their RRF scores in descending order
        sorted_items = sorted(rrf_map.items(), key=lambda x: x[1], reverse=True)
    
        # Return tuple of list of sorted documents by score and sorted documents
        return sorted_items, [item for item, score in sorted_items]


We can use the RRF function above as follows:

    # Combine the lists using RRF
    hybrid_top_k = reciprocal_rank_fusion(vector_top_k, bm25_top_k)
    hybrid_top_k[1]
    
    hybrid_top_k_docs = [contextual_chunks[index] for index in hybrid_top_k[1]]


Now we add a retrieval quality improvement step here to make sure only the highest and most semantically similar chunks get sent to our LLM.

    query = "What are 'skip-level' meetings?" # we keep the same query - can change if we want
    
    response = client.rerank.create(
      model="Salesforce/Llama-Rank-V1",
      query=query,
      documents=hybrid_top_k_docs,
      top_n=3 # we only want the top 3 results but this can be alot higher
    )
    
    for result in response.results:
        retrieved_chunks += hybrid_top_k_docs[result.index] + '\n\n'
    
    print(retrieved_chunks)


This will produce the following three chunks from our essay:

    This chunk refers to "skip-level" meetings, which are a key characteristic of founder mode, where the CEO engages directly with the company beyond their direct reports. This contrasts with the "manager mode" of addressing company issues, where decisions are made perfunctorily via a hierarchical system, to which founders instinctively rebel. that there's a name for it. And once you abandon that constraint there are a huge number of permutations to choose from.For example, Steve Jobs used to run an annual retreat for what he considered the 100 most important people at Apple, and these wer
    
    This chunk discusses the shift in company management away from the "manager mode" that most companies follow, where CEOs engage with the company only through their direct reports, to "founder mode", where CEOs engage more directly with even higher-level employees and potentially skip over direct reports, potentially leading to "skip-level" meetings. ts of, it's pretty clear that it's going to break the principle that the CEO should engage with the company only via his or her direct reports. "Skip-level" meetings will become the norm instead of a practice so unusual that there's a name for it. An
    
    This chunk explains that founder mode, a hypothetical approach to running a company by its founders, will differ from manager mode in that founders will engage directly with the company, rather than just their direct reports, through "skip-level" meetings, disregarding the traditional principle that CEOs should only interact with their direct reports, as managers do.  can already guess at some of the ways it will differ.The way managers are taught to run companies seems to be like modular design in the sense that you treat subtrees of the org chart as black boxes. You tell your direct reports what to do, and it's


We will pass the finalized 3 chunks into an LLM to get our final answer.

    # Generate a story based on the top 10 most similar movies
    
    query = "What are 'skip-level' meetings?"
    
    response = client.chat.completions.create(
        model="meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
        messages=[
          {"role": "system", "content": "You are a helpful chatbot."},
          {"role": "user", "content": f"Answer the question: {query}. Here is relevant information: {retrieved_chunks}"},
        ],
    )


Which produces the following response:

    '"Skip-level" meetings refer to a management practice where a CEO or high-level executive engages directly with employees who are not their direct reports, bypassing the traditional hierarchical structure of the organization. This approach is characteristic of "founder mode," where the CEO seeks to have a more direct connection with the company beyond their immediate team. In contrast to the traditional "manager mode," where decisions are made through a hierarchical system, skip-level meetings allow for more open communication and collaboration between the CEO and various levels of employees. This approach is often used by founders who want to stay connected to the company\'s operations and culture, and to foster a more flat and collaborative organizational structure.'


Above we implemented Contextual Retrieval as discussed in Anthropic's blog using fully open source models!

If you want to learn more about how to best use open models refer to our [docs here](https://docs.together.ai/docs) !

Updated 6 months ago

* * *

*   [Table of Contents](#)
*   *   [Contextual RAG:](#contextual-rag)
*   [Install Libraries](#install-libraries)
*   [Data Processing and Chunking](#data-processing-and-chunking)
*   [Generating Contextual Chunks](#generating-contextual-chunks)
*   [Vector Index](#vector-index)
*   [BM25 Index](#bm25-index)
*   [Everything below this point will happen at query time!](#everything-below-this-point-will-happen-at-query-time)
*   [Reranker To improve Quality](#reranker-to-improve-quality)
*   [Call Generative Model - Llama 3.1 405B](#call-generative-model---llama-31-405b)